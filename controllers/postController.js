/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: packages/quelora-public-api/controllers/postController.js */
/**
 * @fileoverview Post Controller (Production Ready)
 * @module controllers/postController
 * @description Handles all interactions related to Posts (Entities), including threading, 
 * commenting, liking, sharing, and statistics retrieval.
 * * FEATURES:
 * - Smart Ranking (Gravity Decay) via 'ranking_score'.
 * - Compound Cursor Pagination for score-based sorting.
 * - Enterprise Integration (Resilience, Ads, Surveys).
 * - Real-time Presence Hydration.
 */

const { mongoose } = require('@quelora/common/db');
const crypto = require('crypto');

// Models
const Post = require('@quelora/common/models/Post');
const Profile = require('@quelora/common/models/Profile');
const ProfileLike = require('@quelora/common/models/ProfileLike');
const ProfileShare = require('@quelora/common/models/ProfileShare');
const ProfileBookmark = require('@quelora/common/models/ProfileBookmark');
const Comment = require('@quelora/common/models/Comment');
const ProfileFollowing = require('@quelora/common/models/ProfileFollowing');
const ProfileFollower = require('@quelora/common/models/ProfileFollower');
const ProfileFollowRequest = require('@quelora/common/models/ProfileFollowRequest');

// Services
const { cacheService } = require('@quelora/common/services/cacheService');
const profileService = require('@quelora/common/services/profileService');
const userEventService = require('@quelora/common/services/userEventService');
const clientConfigService = require('@quelora/common/services/clientConfigService');
const { getUsersOnlineStatusBatch, incrementActivityScore } = require('@quelora/common/services/activeUsersService');

// Utils
const formatComment = require('@quelora/common/utils/formatComment');
const { getSessionUserId, getProfilesForComments } = require('@quelora/common/utils/profileUtils');
const { loadOptionalModule } = require('@quelora/common/utils/featureLoader');

// Enterprise Modules (Optional)
const Enterprise = loadOptionalModule('@quelora/enterprise');
const resilienceService = Enterprise?.resilienceService;
const adsService = Enterprise?.adsService;
const survey = Enterprise?.Survey;

// Constants
const LIMIT_COMMENTS = parseInt(process.env.LIMIT_COMMENTS, 10) || 15;
const MAX_ENTITIES_LIMIT = 40;
const SIDECAR_TTL = 600; // 10 Minutes

/* ==========================================================================
   Internal Helper Functions
   ========================================================================== */

const generateCacheHash = (inputString) => {
    return crypto.createHash('sha256')
        .update(inputString)
        .digest('hex')
        .substring(0, 32);
};

const incrementPostViews = async (cid, entities) => {
    if (!entities.length) return;
    const promises = entities.map(entity => {
        const viewCacheKey = `cid:${cid}:postViews:${entity}`;
        return cacheService.increment(viewCacheKey, 3600);
    });
    await Promise.all(promises);
};

const enrichPostsWithsurveyStatus = async (cid, posts) => {
    if (!survey || !posts || posts.length === 0) return new Set();
    try {
        const postIds = posts.map(p => p._id);
        const now = new Date();
        const activeSurveys = await survey.find({
            cids: cid,
            posts: { $in: postIds },
            startTime: { $lte: now },
            endTime: { $gte: now }
        }).select('posts').lean();

        const surveyMap = new Set();
        activeSurveys.forEach(s => {
            s.posts.forEach(postId => surveyMap.add(postId.toString()));
        });
        return surveyMap;
    } catch (error) {
        return new Set();
    }
};

const enrichPostsWithAdsStatus = async (cid, posts) => {
    if (!adsService || !posts || posts.length === 0) {
        return { adMap: new Set(), hasOverlays: false };
    }
    try {
        const { adPostMap, hasOverlays } = await adsService.getAdFlagsForPosts(cid, posts);
        return { adMap: adPostMap || new Set(), hasOverlays: hasOverlays || false };
    } catch (error) {
        return { adMap: new Set(), hasOverlays: false };
    }
};

const hydrateCommentsWithLikes = async (commentsList, author, cid) => {
    if (!author || !commentsList.length) return commentsList;
    try {
        let profileId = await getSessionUserId(author, cid);
        if (!profileId) {
            const profile = await profileService.getProfile(author, cid);
            profileId = profile?._id;
        }
        if (!profileId) return commentsList;

        const commentIds = commentsList.map(c => c._id);
        const userLikes = await ProfileLike.find({
            profile_id: profileId,
            fk_id: { $in: commentIds },
            fk_type: 'comment'
        }).select('fk_id').lean();

        const likedSet = new Set(userLikes.map(l => l.fk_id.toString()));

        return commentsList.map(c => ({
            ...c,
            authorLiked: c._id ? likedSet.has(c._id.toString()) : false
        }));
    } catch (error) {
        console.error('Error hydrating comments:', error);
        return commentsList;
    }
};

const hydratePresenceInComments = async (commentsList, cid) => {
    if (!commentsList || commentsList.length === 0) return commentsList;
    if (!cid) {
        console.warn('[PostController] Missing CID for presence hydration, skipping.');
        return commentsList;
    }

    const authorIds = new Set();

    const traverseAndCollect = (nodes) => {
        nodes.forEach(node => {
            if (node.author) authorIds.add(node.author);
            if (node.replies?.list?.length > 0) {
                traverseAndCollect(node.replies.list);
            }
        });
    };
    traverseAndCollect(commentsList);

    const presenceMap = await getUsersOnlineStatusBatch(Array.from(authorIds), cid);

    const traverseAndInject = (nodes) => {
        return nodes.map(node => {
            const newNode = { ...node };
            if (newNode.author && newNode.profile && presenceMap[newNode.author]) {
                const status = presenceMap[newNode.author];
                newNode.profile = {
                    ...newNode.profile,
                    online: status.online,
                    lastSeen: status.lastSeen
                };
            }
            if (newNode.replies?.list?.length > 0) {
                newNode.replies = {
                    ...newNode.replies,
                    list: traverseAndInject(newNode.replies.list)
                };
            }
            return newNode;
        });
    };
    return traverseAndInject(commentsList);
};

const generateSidecarData = async (cid, author, postEntities = [], commentIds = []) => {
    if (!author || ((!postEntities || postEntities.length === 0) && (!commentIds || commentIds.length === 0))) return null;
    try {
        let profileId = await getSessionUserId(author, cid);
        if (!profileId) {
            const profile = await profileService.getProfile(author, cid);
            profileId = profile?._id;
        }
        if (!profileId) return null;

        const pidStr = profileId.toString();
        const cleanEntities = Array.isArray(postEntities) ? postEntities.sort() : [];
        const cleanComments = Array.isArray(commentIds) ? commentIds.sort() : [];
        const compositionString = `${cid}:${pidStr}:${cleanEntities.join(',')}:${cleanComments.join(',')}`;
        const hash = generateCacheHash(compositionString);
        const cacheKey = `cid:${cid}:sidecar:${pidStr}:${hash}`;
        
        const cachedSidecar = await cacheService.get(cacheKey);
        if (cachedSidecar) return cachedSidecar;

        const sidecar = {};
        const targetIds = []; 
        const idToKeyMap = new Map(); 

        if (cleanEntities.length > 0) {
            const posts = await Post.find({ entity: { $in: cleanEntities }, cid }).select('_id entity').lean();
            posts.forEach(p => {
                targetIds.push(p._id);
                idToKeyMap.set(p._id.toString(), p.entity.toString());
            });
        }

        if (cleanComments.length > 0) {
            cleanComments.forEach(cId => {
                if (mongoose.Types.ObjectId.isValid(cId)) {
                    const idObj = new mongoose.Types.ObjectId(cId);
                    targetIds.push(idObj);
                    idToKeyMap.set(cId.toString(), cId.toString());
                }
            });
        }

        if (targetIds.length === 0) return {};

        const [bookmarks, likes] = await Promise.all([
            ProfileBookmark.find({ profile_id: profileId, post_id: { $in: targetIds } }).select('post_id').lean(),
            ProfileLike.find({ profile_id: profileId, fk_id: { $in: targetIds } }).select('fk_id').lean()
        ]);

        bookmarks.forEach(b => {
            const key = idToKeyMap.get(b.post_id.toString());
            if (key) {
                if (!sidecar[key]) sidecar[key] = {};
                sidecar[key].authorBookmarked = true;
            }
        });

        likes.forEach(l => {
            const key = idToKeyMap.get(l.fk_id.toString());
            if (key) {
                if (!sidecar[key]) sidecar[key] = {};
                sidecar[key].authorLiked = true;
            }
        });

        await cacheService.set(cacheKey, sidecar, SIDECAR_TTL);
        return sidecar;

    } catch (e) {
        console.error('[PostController] Error generating sidecar:', e);
        return null;
    }
};

/**
 * Returns the MongoDB Sort object based on the strategy.
 * NOTE: We always append _id: -1 as a tie-breaker for deterministic sorting.
 */
const getSortCriteria = (sortBy = 'smart') => {
    switch (sortBy) {
        case 'newest': return { created_at: -1, _id: -1 };
        case 'oldest': return { created_at: 1, _id: 1 };
        case 'top': return { likesCount: -1, _id: -1 };
        case 'smart': 
        default:
            return { ranking_score: -1, _id: -1 };
    }
};

/* ==========================================================================
   Exported Controller Methods
   ========================================================================== */

exports.getNestedComments = async (req, res, next) => {
    try {
        const { entity } = req.params;
        const author = req?.user?.author ?? null;
        const { commentId, sort } = req.query; 
        const cid = req.cid;
        const sortBy = sort || 'smart';

        if (!mongoose.Types.ObjectId.isValid(commentId)) throw new Error('Invalid comment ID');

        const cacheKey = `cid:${cid}:nested:${commentId}:sort:${sortBy}:structure`;
        let result = await cacheService.get(cacheKey);
        let fromCache = false;

        if (result) {
            fromCache = true;
        } else {
            const rootComment = await Comment.findOne({ _id: commentId, visible: true }).lean();
            if (!rootComment) throw new Error('Comment not found or not visible');

            // Using graphLookup for efficiency in deep structures
            const pipeline = [
                { $match: { _id: new mongoose.Types.ObjectId(commentId), visible: true } },
                {
                    $graphLookup: {
                        from: 'comments',
                        startWith: '$_id',
                        connectFromField: '_id',
                        connectToField: 'parent',
                        as: 'allReplies',
                        maxDepth: 10,
                        restrictSearchWithMatch: { visible: true }
                    }
                }
            ];

            const results = await Comment.aggregate(pipeline);
            if (!results || results.length === 0) throw new Error('Comment not found');

            const allDescendants = results[0].allReplies || [];
            
            // --- IN-MEMORY SORTING FOR NESTED VIEWS ---
            // GraphLookup results come in random order. We must sort them before reconstructing the tree.
            const sortFn = (a, b) => {
                if (sortBy === 'newest') return new Date(b.created_at) - new Date(a.created_at);
                if (sortBy === 'oldest') return new Date(a.created_at) - new Date(b.created_at);
                if (sortBy === 'top') {
                    if (b.likesCount !== a.likesCount) return b.likesCount - a.likesCount;
                    return b._id.toString().localeCompare(a._id.toString()); // Tie-breaker
                }
                // Smart / Default
                const scoreA = a.ranking_score || 0;
                const scoreB = b.ranking_score || 0;
                if (scoreB !== scoreA) return scoreB - scoreA;
                return b._id.toString().localeCompare(a._id.toString()); // Tie-breaker
            };
            
            allDescendants.sort(sortFn);

            const allCommentsFlat = [rootComment, ...allDescendants];
            const profileMap = await getProfilesForComments(allCommentsFlat, null, cid);
            const formattedCommentsMap = new Map();

            await Promise.all(allCommentsFlat.map(async c => {
                const formatted = await formatComment(
                    { ...c, replies_visibles: c.repliesCount || 0 },
                    profileMap[c.author],
                    null,
                    false
                );
                formatted.replies = { list: [], totalReplies: 0, hasMore: false };
                formattedCommentsMap.set(c._id.toString(), formatted);
            }));

            const rootFormatted = formattedCommentsMap.get(rootComment._id.toString());
            
            // Reconstruct Tree preserving the Sorted Order
            allDescendants.forEach(descendant => {
                const childNode = formattedCommentsMap.get(descendant._id.toString());
                const parentId = descendant.parent.toString();
                if (formattedCommentsMap.has(parentId)) {
                    const parentNode = formattedCommentsMap.get(parentId);
                    parentNode.replies.list.push(childNode);
                    parentNode.replies.totalReplies++;
                }
            });

            result = {
                entityId: entity,
                commentId,
                totalReplies: rootFormatted.replies.totalReplies,
                hasMore: true,
                list: rootFormatted.replies.list
            };

            await cacheService.set(cacheKey, result, 3600);
        }

        if (author) {
            let profileId = await getSessionUserId(author, cid);
            if (!profileId) {
                const p = await profileService.getProfile(author, cid);
                profileId = p?._id;
            }
            if (profileId) {
                const flatList = [];
                const traverse = (nodes) => {
                    for (const node of nodes) {
                        flatList.push(node);
                        if (node.replies?.list) traverse(node.replies.list);
                    }
                };
                traverse(result.list);
                
                const commentIds = flatList.map(c => c._id);
                const userLikes = await ProfileLike.find({ profile_id: profileId, fk_id: { $in: commentIds }, fk_type: 'comment' }).select('fk_id').lean();
                const likedSet = new Set(userLikes.map(l => l.fk_id.toString()));

                const updateLikes = (nodes) => {
                    return nodes.map(node => {
                        const isLiked = node._id ? likedSet.has(node._id.toString()) : false;
                        const newNode = { ...node, authorLiked: isLiked };
                        if (newNode.replies?.list) newNode.replies.list = updateLikes(newNode.replies.list);
                        return newNode;
                    });
                };
                result.list = updateLikes(result.list);
            }
        }

        if (result.list) result.list = await hydratePresenceInComments(result.list, cid);
        if (fromCache) res.setHeader('X-Cache-App', 'HIT');
        res.status(200).json(result);

    } catch (error) {
        console.error('Error in getNestedComments:', error);
        next(error);
    }
};

exports.getEntityThread = async (req, res, next) => {
    try {
        const { entity } = req.params;
        const author = req?.user?.author ?? null;
        const { lastCommentId, includeLast, sort } = req.query; 
        const cid = req.cid;
        const parsedLimit = LIMIT_COMMENTS;
        const sortBy = sort || 'smart';
        const shouldInclude = includeLast === 'true'; 

        const baseCacheKey = `cid:${cid}:thread:${entity}:limit:${parsedLimit}:last:${lastCommentId || 'init'}:inc:${shouldInclude}:sort:${sortBy}:struct`;
        const binaryCacheKey = `cid:${cid}:thread:${entity}:limit:${parsedLimit}:last:${lastCommentId || 'init'}:inc:${shouldInclude}:sort:${sortBy}:bin`;

        if (!mongoose.Types.ObjectId.isValid(entity)) return res.status(400).json({ message: 'Invalid entity ID.' });
        if (author) incrementActivityScore(author, cid, 1);

        const threadSidecarGen = async () => {
            if (!author) return null;
            try {
                const post = await Post.findOne({ entity, cid }).select('_id').lean();
                if (!post) return null;
                // Pre-fetch sidecar for recent items
                const commentIds = await Comment.find({ post: post._id, parent: null, visible: true })
                    .sort(getSortCriteria(sortBy))
                    .limit(parsedLimit)
                    .select('_id')
                    .lean()
                    .then(docs => docs.map(d => d._id.toString()));
                return generateSidecarData(cid, author, [entity], commentIds);
            } catch (e) { return null; }
        };

        if (resilienceService && await resilienceService.tryServeBinary(res, { key: binaryCacheKey, scope: 'public', sidecarGen: threadSidecarGen })) return;

        let result = await cacheService.get(baseCacheKey);
        let fromCache = false;

        if (result) {
            fromCache = true;
        } else {
            const post = await Post.findOne({ entity, cid, 'deletion.status': 'active' })
                .select('likesCount sharesCount commentCount')
                .lean();

            if (!post) return res.status(404).json({ message: 'Post not found.' });

            // Base Query
            const commentQuery = { post: post._id, parent: null, visible: true };
            
            /* * =========================================================================
             * CRITICAL PAGINATION LOGIC (CURSOR-BASED)
             * =========================================================================
             * * Problem: Pagination by simple ID only works for time-based sorts (Monotonic).
             * For Score-based sorts (Smart/Top), elements move around. A simple _id filter
             * misses items if their score is the same or higher but ID is lower.
             * * Solution: Compound Cursor.
             * We must filter by: (Score < LastScore) OR (Score == LastScore AND _id < LastID)
             * * UPDATE: Explicitly cast lastCommentId to ObjectId for robust comparisons.
             */
            
            if (lastCommentId && mongoose.Types.ObjectId.isValid(lastCommentId)) {
                
                // Explicitly cast to ObjectId to ensure correct MongoDB comparison in complex queries
                const lastIdObj = new mongoose.Types.ObjectId(lastCommentId);

                // CASE A: Time-based Sorting (Simple ID Cursor)
                if (sortBy === 'newest' || sortBy === 'oldest') {
                    if (sortBy === 'newest') {
                        // Newest: Lower ID means older time
                        commentQuery._id = shouldInclude ? { $lte: lastIdObj } : { $lt: lastIdObj };
                    } else {
                        // Oldest: Higher ID means newer time
                        commentQuery._id = shouldInclude ? { $gte: lastIdObj } : { $gt: lastIdObj };
                    }
                } 
                
                // CASE B: Value-based Sorting (Smart / Top)
                else {
                    // 1. Fetch the reference element (the last one seen by the client)
                    const lastComment = await Comment.findById(lastCommentId)
                        .select('ranking_score likesCount _id')
                        .lean();

                    if (lastComment) {
                        const scoreField = sortBy === 'smart' ? 'ranking_score' : 'likesCount';
                        const lastValue = lastComment[scoreField] || 0;
                        const operator = shouldInclude ? '$lte' : '$lt';

                        // 2. Construct Compound Filter
                        // "Give me items with strictly lower score..."
                        // "OR... items with equal score but 'older' ID (Tie-Breaker)"
                        commentQuery.$or = [
                            { [scoreField]: { $lt: lastValue } }, // Major sort is always strictly less (descending)
                            { 
                                [scoreField]: lastValue, 
                                _id: { [operator]: lastIdObj } // Deterministic secondary sort with inclusive support & explicit casting
                            }
                        ];
                    }
                }
            }

            const sortCriteria = getSortCriteria(sortBy);
            
            // Limit + 1 strategy to check hasMore
            const limitCount = parsedLimit + (shouldInclude ? 0 : 1);

            const comments = await Comment.find(commentQuery)
                .sort(sortCriteria)
                .limit(limitCount)
                .lean();

            let hasMore = false;
            let paginatedComments = comments;

            if (!shouldInclude) {
                hasMore = comments.length > parsedLimit;
                paginatedComments = hasMore ? comments.slice(0, parsedLimit) : comments;
            }

            let formattedComments = [];
            if (paginatedComments.length > 0) {
                const profileMap = await getProfilesForComments(paginatedComments, null, cid);
                formattedComments = await Promise.all(
                    paginatedComments.map(c => formatComment(
                        { ...c, replies_visibles: c.repliesCount || 0 },
                        profileMap[c.author],
                        null,
                        false
                    ))
                );
            }

            result = {
                entity,
                likes: post.likesCount || 0,
                shares: post.sharesCount || 0,
                comments: {
                    total: post.commentCount || 0,
                    hasMore,
                    list: formattedComments,
                    // Return the ID of the last element so client can request next page
                    lastCommentId: paginatedComments.length > 0 
                        ? paginatedComments[paginatedComments.length - 1]._id 
                        : null,
                },
            };

            await cacheService.set(baseCacheKey, result, 3600);
        }

        if (resilienceService) {
            const sidecarData = author ? await threadSidecarGen() : null;
            const sent = await resilienceService.sendArtifact(res, { data: result, cid, key: binaryCacheKey, scope: 'public', sidecarData });
            if (sent) return;
        }

        if (author) {
            result.comments.list = await hydrateCommentsWithLikes(result.comments.list, author, cid);
            const postSidecar = await threadSidecarGen();
            if (postSidecar && postSidecar[entity]) {
                result.authorLiked = postSidecar[entity].authorLiked;
                result.authorBookmarked = postSidecar[entity].authorBookmarked;
            }
        }

        if (result.comments.list) result.comments.list = await hydratePresenceInComments(result.comments.list, cid);
        if (fromCache) res.setHeader('X-Cache-App', 'HIT');
        res.status(200).json(result);

    } catch (error) {
        next(error);
    }
};

exports.getEntityReplies = async (req, res, next) => {
    try {
        const { entity, commentId } = req.params;
        const { lastCommentId, includeLast, sort } = req.query; // FIX: Added includeLast
        const author = req?.user?.author ?? null;
        const cid = req.cid;
        const parsedLimit = LIMIT_COMMENTS;
        const sortBy = sort || 'smart';
        const shouldInclude = includeLast === 'true'; // FIX: Enabled inclusive mode

        const baseCacheKey = `cid:${cid}:thread:${entity}:${commentId}:limit:${parsedLimit}:last:${lastCommentId || 'none'}:inc:${shouldInclude}:sort:${sortBy}:structure`;
        const binaryCacheKey = `cid:${cid}:thread:${entity}:${commentId}:limit:${parsedLimit}:last:${lastCommentId || 'none'}:inc:${shouldInclude}:sort:${sortBy}:binary`;

        if (!mongoose.Types.ObjectId.isValid(entity) || !mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ message: 'Invalid entity or comment ID.' });
        }
        if (author) incrementActivityScore(author, cid, 1);
        if (resilienceService && await resilienceService.tryServeBinary(res, { key: binaryCacheKey, scope: 'public' })) return;

        let result = await cacheService.get(baseCacheKey);
        let fromCache = false;

        if (result) {
            fromCache = true;
        } else {
            const post = await Post.findOne({ entity, cid, 'deletion.status': 'active' }).select('_id').lean();
            if (!post) return res.status(404).json({ message: 'Post not found.' });
            const parentComment = await Comment.findOne({ _id: commentId, post: post._id, visible: true }).select('repliesCount').lean();
            if (!parentComment) return res.status(404).json({ message: 'Comment not found.' });

            const repliesQuery = { parent: commentId, visible: true };
            
            // --- COMPOUND CURSOR PAGINATION FOR REPLIES (FIXED) ---
            if (lastCommentId && mongoose.Types.ObjectId.isValid(lastCommentId)) {
                
                const lastIdObj = new mongoose.Types.ObjectId(lastCommentId);

                if (sortBy === 'newest' || sortBy === 'oldest') {
                    if (sortBy === 'newest') {
                        repliesQuery._id = shouldInclude ? { $lte: lastIdObj } : { $lt: lastIdObj };
                    } else {
                        repliesQuery._id = shouldInclude ? { $gte: lastIdObj } : { $gt: lastIdObj };
                    }
                } else {
                    // Smart / Top Sorting
                    const lastComment = await Comment.findById(lastCommentId)
                        .select('ranking_score likesCount _id')
                        .lean();

                    if (lastComment) {
                        const scoreField = sortBy === 'smart' ? 'ranking_score' : 'likesCount';
                        const lastValue = lastComment[scoreField] || 0;
                        const operator = shouldInclude ? '$lte' : '$lt';

                        repliesQuery.$or = [
                            { [scoreField]: { $lt: lastValue } },
                            { 
                                [scoreField]: lastValue, 
                                _id: { [operator]: lastIdObj } // Explicit casting + inclusive support
                            }
                        ];
                    }
                }
            }

            const sortCriteria = getSortCriteria(sortBy);
            const limitCount = parsedLimit + (shouldInclude ? 0 : 1);

            const replies = await Comment.find(repliesQuery)
                .sort(sortCriteria)
                .limit(limitCount)
                .lean();

            let hasMore = false;
            let paginatedReplies = replies;

            if (!shouldInclude) {
                hasMore = replies.length > parsedLimit;
                paginatedReplies = hasMore ? replies.slice(0, parsedLimit) : replies;
            }

            const profileMap = await getProfilesForComments(paginatedReplies, null, cid);
            const formattedReplies = await Promise.all(
                paginatedReplies.map(r => formatComment({ ...r, replies_visibles: r.repliesCount || 0 }, profileMap[r.author], null, false))
            );

            result = {
                entity, commentId,
                comments: {
                    list: formattedReplies,
                    totalReplies: parentComment.repliesCount || 0,
                    hasMore,
                    // Return last ID for next page request
                    lastCommentId: paginatedReplies.length > 0 
                        ? paginatedReplies[paginatedReplies.length - 1]._id 
                        : null,
                },
            };
            await cacheService.set(baseCacheKey, result, 3600);
        }

        if (resilienceService) {
            const sent = await resilienceService.sendArtifact(res, { data: result, cid, key: binaryCacheKey, scope: 'public' });
            if (sent) return;
        }

        if (author) {
            result.comments.list = await hydrateCommentsWithLikes(result.comments.list, author, cid);
        }
        if (result.comments.list) result.comments.list = await hydratePresenceInComments(result.comments.list, cid);

        if (fromCache) res.setHeader('X-Cache-App', 'HIT');
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.getPostStats = async (req, res, next) => {
    try {
        const { entities, mapping } = req.query;
        const author = req?.user?.author || '';
        const cid = req.cid;
        const clientConfig = await clientConfigService.getClientPostConfig(cid);
        if (!entities) return res.status(400).json({ message: 'A valid entities array is required.' });
        let parsedEntities, parsedMapping = {};
        try {
            parsedEntities = JSON.parse(entities);
            if (mapping) parsedMapping = JSON.parse(mapping);
        } catch (error) { return res.status(400).json({ message: 'Invalid format.' }); }

        if (!Array.isArray(parsedEntities) || parsedEntities.length === 0) return res.status(400).json({ message: 'Array required.' });
        if (parsedEntities.length > MAX_ENTITIES_LIMIT) return res.status(400).json({ message: 'Limit exceeded.' });

        await incrementPostViews(cid, parsedEntities);
        if (author) incrementActivityScore(author, cid, 1);
        
        const normalizedEntities = [...parsedEntities].sort();
        const entitiesHash = generateCacheHash(normalizedEntities.join(':'));
        const cacheKey = `cid:${cid}:stats:structure:${entitiesHash}`;
        const binaryCacheKey = `cid:${cid}:stats:binary:${entitiesHash}`;

        const statsSidecarGen = async () => {
             if (!author) return null;
             return generateSidecarData(cid, author, parsedEntities);
        };

        if (resilienceService && await resilienceService.tryServeBinary(res, { key: binaryCacheKey, scope: 'public', sidecarGen: statsSidecarGen })) return;

        let postsData = await cacheService.get(cacheKey);

        let posts = postsData;
        if (!posts) {
            posts = await Post.find({ entity: { $in: parsedEntities }, cid })
                .select('_id entity likesCount sharesCount commentCount viewsCount config.comment_status config.visibility config.interaction config.limits config.editing config.language config.liveMode')
                .lean();
        }

        const [surveyMap, adsStatus] = await Promise.all([
            enrichPostsWithsurveyStatus(cid, posts),
            enrichPostsWithAdsStatus(cid, posts)
        ]);

        const { adMap, hasOverlays } = adsStatus;
        const result = posts.map(post => ({
            entity: post.entity,
            likesCount: post.likesCount || 0,
            sharesCount: post.sharesCount || 0,
            commentsCount: post.commentCount || 0,
            viewsCount: post.viewsCount || 0,
            authorLiked: false,
            authorBookmarked: false,
            config: {
                hasActiveSurvey: post._id ? surveyMap.has(post._id.toString()) : false,
                ads: { hasInFeed: post._id ? adMap.has(post._id.toString()) : false, hasOverlays: hasOverlays },
                visibility: post.config?.visibility || 'public',
                comment_status: post.config?.comment_status || 'open',
                interaction: {
                    allow_comments: post.config?.interaction?.allow_comments ?? clientConfig?.interaction?.allow_comments ?? true,
                    allow_likes: post.config?.interaction?.allow_likes ?? clientConfig?.interaction?.allow_likes ?? true,
                    allow_shares: post.config?.interaction?.allow_shares ?? clientConfig?.interaction?.allow_shares ?? true,
                    allow_replies: post.config?.interaction?.allow_replies ?? clientConfig?.interaction?.allow_replies ?? true,
                    allow_view_comments: post.config?.interaction?.allow_view_comments ?? clientConfig?.interaction?.allow_view_comments ?? true,
                    allow_bookmarks: post.config?.interaction?.allow_bookmarks ?? clientConfig?.interaction?.allow_bookmarks ?? false,
                    allow_quotes: post.config?.interaction?.allow_quotes ?? clientConfig?.interaction?.allow_quotes ?? true,
                },
                limits: {
                    comment_text: post.config?.limits?.comment_text ?? clientConfig?.limits?.comment_text ?? 200,
                    reply_text: post.config?.limits?.reply_text ?? clientConfig?.limits?.reply_text ?? 200,
                },
                editing: {
                    allow_edits: post.config?.editing?.allow_edits ?? clientConfig?.editing?.allow_edits ?? true,
                    edit_time_limit: post.config?.editing?.edit_time_limit ?? clientConfig?.editing?.edit_time_limit ?? 5,
                    allow_delete: post.config?.editing?.allow_delete ?? clientConfig?.editing?.allow_delete ?? true,
                },
                language: {
                    post_language: post.config?.language?.post_language ?? 'en',
                    auto_translate: post.config?.language?.auto_translate ?? false,
                },
                liveMode: post.config?.liveMode ?? false
            }
        }));

        if (resilienceService) {
            const sidecarData = author ? await statsSidecarGen() : null;
            const sent = await resilienceService.sendArtifact(res, { data: result, cid, key: binaryCacheKey, scope: 'public', sidecarData, isBatch: true });
            if (sent) return;
        }

        const sidecar = await statsSidecarGen();
        const hydratedResult = result.map(p => {
            const state = sidecar && sidecar[p.entity] ? sidecar[p.entity] : {};
            return { ...p, authorLiked: state.authorLiked || false, authorBookmarked: state.authorBookmarked || false };
        });

        if (postsData) res.setHeader('X-Cache-App', 'HIT');
        res.status(200).json({ posts: hydratedResult, status: 'ok' });

    } catch (error) {
        console.error('Error in getPostStats:', error);
        next(error);
    }
};

exports.getPostLikes = async (req, res, next) => {
    try {
        const { entity } = req.params;
        const cid = req.cid;
        const author = req?.user?.author || null;
        const limit = 100;

        if (!mongoose.Types.ObjectId.isValid(entity)) return res.status(400).json({ message: 'Invalid entity ID.' });

        const cacheKey = `cid:${cid}:postLikes:${entity}:structure`;
        let response = await cacheService.get(cacheKey);
        let fromCache = false;

        if (response) {
            fromCache = true;
        } else {
            const post = await Post.findOne({ entity, cid, 'deletion.status': 'active' }).select('_id likesCount viewsCount').lean();
            if (!post) return res.status(404).json({ message: 'Post not found.' });

            const likes = await ProfileLike.aggregate([
                { $match: { fk_id: post._id, fk_type: 'post' } },
                { $sort: { created_at: -1 } },
                { $limit: limit },
                { $lookup: { from: 'profiles', localField: 'profile_id', foreignField: '_id', as: 'profile' } },
                { $unwind: { path: '$profile', preserveNullAndEmptyArrays: false } },
                { $match: { 'profile.cid': cid } },
                { $project: { _id: 0, profileId: '$profile._id', author: '$profile.author', name: { $ifNull: ['$profile.name', 'Unknown'] }, given_name: { $ifNull: ['$profile.given_name', 'Unknown'] }, family_name: { $ifNull: ['$profile.family_name', 'Unknown'] }, picture: { $ifNull: ['$profile.picture', ''] }, locale: { $ifNull: ['$profile.locale', 'es'] }, created_at: { $ifNull: ['$profile.created_at', new Date()] } } }
            ]);

            response = { totalLikes: post.likesCount || 0, viewsCount: post.viewsCount || 0, displayedLikes: likes.length, likes };
            await cacheService.set(cacheKey, response, 3600);
        }

        if (author) {
            const currentProfileId = await getSessionUserId(author, cid);
            if (currentProfileId) {
                const profileIds = response.likes.map(l => l.profileId);
                const [following, followers, pending] = await Promise.all([
                    ProfileFollowing.find({ follower_id: currentProfileId, following_id: { $in: profileIds } }).select('following_id').lean(),
                    ProfileFollower.find({ profile_id: currentProfileId, follower_id: { $in: profileIds } }).select('follower_id').lean(),
                    ProfileFollowRequest.find({ profile_id: currentProfileId, target_id: { $in: profileIds }, status: 'pending' }).select('target_id').lean()
                ]);
                const followingSet = new Set(following.map(f => f.following_id.toString()));
                const followerSet = new Set(followers.map(f => f.follower_id.toString()));
                const pendingSet = new Set(pending.map(p => p.target_id.toString()));

                response.likes = response.likes.map(like => ({
                    ...like,
                    isFollowing: followingSet.has(like.profileId.toString()),
                    isFollower: followerSet.has(like.profileId.toString()),
                    isFollowRequestSent: pendingSet.has(like.profileId.toString())
                }));
            }
        }
        if (fromCache) res.setHeader('X-Cache-App', 'HIT');
        res.status(200).json(response);
    } catch (error) {
        console.error("Error getting post likes:", error);
        next(error);
    }
};

exports.likePost = async (req, res, next) => {
    try {
        const { entity } = req.params;
        const author = req.user.author;
        const cid = req.cid;
        if (!mongoose.Types.ObjectId.isValid(entity)) return res.status(400).json({ message: 'Invalid entity ID.' });

        const post = await Post.findOne({ entity, cid, 'deletion.status': 'active' });
        if (!post) return res.status(404).json({ message: 'Post not found.' });
        if (!post.config.interaction.allow_likes) return res.status(403).json({ message: 'Likes are not allowed.' });

        const profile = await Profile.ensureProfileExists(req.user, req.cid, req.geoData || null);
        const existingLike = await ProfileLike.findOne({ profile_id: profile._id, fk_id: post._id, fk_type: 'post' });

        if (existingLike) {
            await existingLike.deleteOne();
            const updatedPost = await Post.findByIdAndUpdate(post._id, { $inc: { likesCount: -1 } }, { new: true });
            await userEventService.onLikeRemoved({ req, entity, targetType: 'post', targetId: post._id, profile });
            return res.status(200).json({ liked: false, likesCount: updatedPost.likesCount, message: 'Like removed.' });
        } else {
            await ProfileLike.create({ profile_id: profile._id, fk_id: post._id, fk_type: 'post', created_at: Date.now() });
            const updatedPost = await Post.findByIdAndUpdate(post._id, { $inc: { likesCount: 1 } }, { new: true });
            await userEventService.onPostLiked({ req, entity, post, profile });
            res.status(200).json({ liked: true, likesCount: updatedPost.likesCount, message: 'Like added.' });
        }
    } catch (error) {
        console.error("Error in likePost:", error);
        next(error);
    }
};

exports.sharePost = async (req, res, next) => {
    try {
        const { entity } = req.params;
        const author = req?.user?.author || null;
        const cid = req.cid;
        if (!mongoose.Types.ObjectId.isValid(entity)) return res.status(400).json({ message: 'Invalid entity ID.' });

        const post = await Post.findOne({ entity, cid, 'deletion.status': 'active' });
        if (!post) return res.status(404).json({ message: 'Post not found.' });
        if (!post.config.interaction.allow_shares) return res.status(403).json({ message: 'Shares are not allowed.' });

        let profile = null;
        const promises = [Post.addShare(post._id)];
        if (author) {
            profile = await Profile.ensureProfileExists(req.user, req.cid, req.geoData || null);
            if (!profile) return res.status(404).json({ message: 'Profile not found.' });
            promises.push(ProfileShare.create({ profile_id: profile._id, post_id: post._id, created_at: Date.now() }));
        }
        promises.push(userEventService.onPostShared({ req, entity, post, profile }));
        await Promise.all(promises);
        res.status(200).json({ message: 'Post shared successfully.', sharesCount: post.sharesCount + 1 });
    } catch (error) {
        console.error("Error sharing post:", error);
        next(error);
    }
};