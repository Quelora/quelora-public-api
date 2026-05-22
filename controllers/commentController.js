/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: packages/quelora-public-api/controllers/commentController.js */
const { mongoose } = require('@quelora/common/db');
const Post = require('@quelora/common/models/Post');
const Profile = require('@quelora/common/models/Profile');
const ProfileLike = require('@quelora/common/models/ProfileLike');
const ProfileComment = require('@quelora/common/models/ProfileComment');
const Comment = require('@quelora/common/models/Comment');
const Report = require('@quelora/common/models/Report');
const CommentAudio = require('@quelora/common/models/CommentAudio');
const ProfileFollowing = require('@quelora/common/models/ProfileFollowing');
const ProfileFollower = require('@quelora/common/models/ProfileFollower');
const ProfileFollowRequest = require('@quelora/common/models/ProfileFollowRequest');

const { processCommentLogic, validateAudio } = require('@quelora/common/services/commentProcessingService');
const { cacheService } = require('@quelora/common/services/cacheService');
const { translateService } = require('@quelora/common/services/translateService');
const clientConfigService = require('@quelora/common/services/clientConfigService');
const profileService = require('@quelora/common/services/profileService');
const userEventService = require('@quelora/common/services/userEventService');
const formatComment = require('@quelora/common/utils/formatComment');
const { getSessionUserId } = require('@quelora/common/utils/profileUtils');
const { calculateHotScore } = require('@quelora/common/utils/rankingUtils');

const processAudio = async (commentId, audio, hash) => {
    await CommentAudio.create({
        comment_id: commentId,
        audioData: audio,
        audioHash: hash,
        created_at: new Date()
    });
};

exports.addComment = async (req, res, next) => {
    try {
        const { entity } = req.params;
        const cid = req.cid;
        const clientConfig = await clientConfigService.getClientPostConfig(cid);
        const { text, audio, hash } = req.body;

        const {
            text: processedText,
            defaultLanguage,
            toxicityScoreAvg,
            post
        } = await processCommentLogic({
            author: req.user.author,
            locale: req.user.locale,
            cid: req.cid,
            text: text,
            entity: entity,
            isReply: false,
            clientConfig
        });

        const allow_save_audio = post.config?.audio?.save_comment_audio ?? clientConfig?.audio?.save_comment_audio ?? false;

        if (allow_save_audio && audio) {
            await validateAudio(processedText, audio, hash, post, clientConfig);
        }

        const [profile, trustSnapshot] = await Promise.all([
            Profile.ensureProfileExists(req.user, req.cid, req.geoData || null),
            profileService.getTrustSnapshot(req.user.author, req.cid)
        ]);

        const newCommentId = new mongoose.Types.ObjectId();
        const now = new Date();

        // --- COLD START FIX & MAPPING CORRECTION ---
        // Normalizamos el score. Si trustSnapshot viene del perfil directo, tendrá 'score'.
        // Si viene transformado, podría tener 'initial_score'. Priorizamos lo que exista.
        const rawTrustScore = trustSnapshot.initial_score ?? trustSnapshot.score ?? 0;

        // Construimos el objeto exacto que espera el Schema de Comment
        const finalTrustSnapshot = {
            level: trustSnapshot.level || 0,
            initial_score: rawTrustScore
        };

        // Calculamos el ranking inicial usando datos limpios
        const initialRankingScore = calculateHotScore({
            created_at: now,
            likesCount: 0,
            repliesCount: 0,
            trust_snapshot: finalTrustSnapshot
        }, now);
        // -------------------------------------------

        const newComment = {
            _id: newCommentId,
            entity,
            post: post._id,
            profile_id: profile._id,
            author: req.user.author,
            text: processedText,
            language: defaultLanguage,
            created_at: now,
            updated_at: now,
            replies: [],
            visible: true,
            hasAudio: !!(audio && allow_save_audio),
            toxicityScore: toxicityScoreAvg,
            parent: null,
            root: newCommentId,
            trust_snapshot: finalTrustSnapshot, // Guardamos el objeto mapeado correctamente
            ranking_score: initialRankingScore  // Guardamos el score pre-calculado
        };

        const promises = [
            Comment.create(newComment),
            Post.incrementComment(post._id),
            ProfileComment.create({ profile_id: profile._id, post_id: post._id, comment_id: newComment._id, created_at: new Date() }),
            userEventService.onCommentAdded({
                req, entity, post, comment: newComment, profile, toxicityScore: toxicityScoreAvg
            })
        ];

        if (allow_save_audio && audio && hash) {
            promises.push(processAudio(newComment._id, audio, hash));
        }

        await Promise.all(promises);
        const authorProfile = await profileService.getProfile(req.user.author, cid);
        const formattedComment = formatComment(newComment, authorProfile, req.user.author);

        res.status(201).json({ message: 'Comment added successfully.', comment: formattedComment });

    } catch (error) {
        res.status(500).json({ message: error.message || 'Internal server error.' });
    }
};

exports.addReply = async (req, res, next) => {
    try {
        const { entity, comment } = req.params;
        const cid = req.cid;
        const clientConfig = await clientConfigService.getClientPostConfig(cid);
        const { text, audio, hash } = req.body;

        const {
            text: processedText,
            defaultLanguage,
            toxicityScoreAvg,
            post
        } = await processCommentLogic({
            author: req.user.author,
            locale: req.user.locale,
            cid: req.cid,
            text: text,
            entity: entity,
            commentId: comment,
            isReply: true,
            clientConfig
        });

        const allow_save_audio = post.config?.audio?.save_comment_audio ?? clientConfig?.audio?.save_comment_audio ?? false;

        if (allow_save_audio && audio) {
            await validateAudio(processedText, audio, hash, post, clientConfig);
        }

        const parentComment = await Comment.findById(comment).select('root author text').lean();
        if (!parentComment) return res.status(404).json({ message: 'Parent comment not found.' });

        const [profile, trustSnapshot] = await Promise.all([
            Profile.ensureProfileExists(req.user, req.cid, req.geoData || null),
            profileService.getTrustSnapshot(req.user.author, req.cid)
        ]);

        const replyId = new mongoose.Types.ObjectId();
        const now = new Date();

        const rawTrustScore = trustSnapshot.initial_score ?? trustSnapshot.score ?? 0;
        
        const finalTrustSnapshot = {
            level: trustSnapshot.level || 0,
            initial_score: rawTrustScore
        };

        const initialRankingScore = calculateHotScore({
            created_at: now,
            likesCount: 0,
            repliesCount: 0,
            trust_snapshot: finalTrustSnapshot
        }, now);

        const reply = {
            _id: replyId,
            entity,
            post: post._id,
            parent: comment,
            root: parentComment.root,
            profile_id: profile._id,
            author: req.user.author,
            language: defaultLanguage,
            text: processedText,
            replies: [],
            created_at: now,
            updated_at: now,
            visible: true,
            hasAudio: !!(audio && allow_save_audio),
            toxicityScore: toxicityScoreAvg,
            trust_snapshot: finalTrustSnapshot, // Mapeo Correcto
            ranking_score: initialRankingScore  // Score Pre-calculado
        };

        const promises = [
            Comment.create(reply),
            Comment.incrementReplies(comment),
            Post.incrementComment(post._id),
            ProfileComment.create({ profile_id: profile._id, post_id: post._id, comment_id: replyId, created_at: new Date() }),
            userEventService.onReplyAdded({
                req, entity, post, reply, parentComment, profile, toxicityScore: toxicityScoreAvg
            })
        ];

        if (allow_save_audio && audio && hash) {
            promises.push(processAudio(replyId, audio, hash));
        }

        await Promise.all(promises);
        const authorProfile = await profileService.getProfile(req.user.author, cid);
        const formattedReply = formatComment(reply, authorProfile, req.user.author);

        res.status(201).json({ message: 'Reply added successfully.', comment: formattedReply });

    } catch (error) {
        res.status(500).json({ message: error.message || 'Internal server error.' });
    }
};

exports.editComment = async (req, res, next) => {
    try {
        const { comment } = req.params;
        const author = req.user.author;
        const cid = req.cid;
        const clientConfig = await clientConfigService.getClientPostConfig(cid);
        const { text: newText } = req.body;

        const commentDoc = await Comment.findOne({ _id: comment, author, visible: true });
        if (!commentDoc) return res.status(404).json({ message: 'Comment not found or not authorized' });
        if (commentDoc.hasAudio) return res.status(403).json({ message: 'Comments with audio cannot be edited' });

        const {
            text: processedText,
            defaultLanguage,
            post
        } = await processCommentLogic({
            author: req.user.author,
            locale: req.user.locale,
            cid: req.cid,
            text: newText,
            entity: commentDoc.entity,
            commentId: commentDoc.parent || null,
            isReply: !!commentDoc.parent,
            clientConfig
        });

        const editing = post.config?.editing ?? clientConfig?.editing ?? {};
        if (editing.allow_edits === false) return res.status(403).json({ message: 'Editing comments is not allowed for this post.' });

        const editTimeLimit = (editing.edit_time_limit || 5) * 60 * 1000;
        if (Date.now() - commentDoc.created_at > editTimeLimit) return res.status(403).json({ message: 'The time to edit this comment has expired.' });

        commentDoc.text = processedText;
        commentDoc.language = defaultLanguage;
        commentDoc.updated_at = new Date();
        await commentDoc.save();

        const authorProfile = await profileService.getProfile(author, cid);
        const formattedComment = formatComment(commentDoc, authorProfile, author);

        res.status(200).json({ message: 'Comment updated successfully', comment: formattedComment });

    } catch (error) {
        res.status(500).json({ message: error.message || 'Internal server error.' });
    }
};

exports.likeComment = async (req, res, next) => {
    try {
        const { entity, comment } = req.params;
        const author = req.user.author;
        const cid = req.cid;

        if (!mongoose.Types.ObjectId.isValid(entity) || !mongoose.Types.ObjectId.isValid(comment)) {
            return res.status(400).json({ error: 'Invalid entity or comment ID' });
        }

        const post = await Post.findOne({ entity, cid, 'deletion.status': 'active' }).select('config.interaction.allow_likes').lean();
        if (!post) return res.status(404).json({ message: 'Post not found' });
        if (!post.config.interaction.allow_likes) return res.status(403).json({ message: 'Likes are not allowed.' });

        const commentDoc = await Comment.findOne({ _id: comment, post: post._id, visible: true })
            .select('author text root profile_id') 
            .lean();
            
        if (!commentDoc) return res.status(404).json({ message: 'Comment not found or not visible' });

        const profile = await profileService.getProfile(author, cid);
        
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const existingLike = await ProfileLike.findOne({ profile_id: profile._id, fk_id: comment, fk_type: 'comment' });

        let updatedComment;
        const promises = [];

        if (existingLike) {
            await existingLike.deleteOne();
            updatedComment = await Comment.decrementLikes(comment);

            promises.push(userEventService.onLikeRemoved({
                req,
                entity,
                targetType: 'comment',
                targetId: comment,
                profile
            }));
        } else {
            await ProfileLike.create({ profile_id: profile._id, fk_id: comment, fk_type: 'comment', created_at: new Date() });
            updatedComment = await Comment.incrementLikes(comment);

            promises.push(userEventService.onCommentLiked({
                req,
                entity,
                comment: commentDoc,
                post,
                profile
            }));
        }

        await Promise.all(promises);

        res.status(200).json({
            liked: !existingLike,
            likesCount: updatedComment.likesCount,
            message: `Like ${existingLike ? 'removed' : 'added'} on the comment :-)`
        });

    } catch (error) {
        next(error);
    }
};

exports.deleteComment = async (req, res, next) => {
    try {
        const { comment } = req.params;
        const author = req.user.author;
        const cid = req.cid;
        const clientConfig = await clientConfigService.getClientPostConfig(cid);

        if (!mongoose.Types.ObjectId.isValid(comment)) return res.status(400).json({ message: 'Invalid comment ID' });

        const commentDoc = await Comment.findOne({ _id: comment, author, visible: true });
        if (!commentDoc) return res.status(404).json({ message: 'Comment not found or not authorized' });

        const postObject = await Post.findById(commentDoc.post).select('config.editing.allow_delete entity').lean();
        if (!postObject) return res.status(404).json({ message: 'Post not found.' });

        const allow_delete = postObject.config?.editing?.allow_delete ?? clientConfig?.editing?.allow_delete ?? true;
        if (!allow_delete) return res.status(403).json({ message: 'Deleting comments is not allowed for this post.' });

        commentDoc.visible = false;
        commentDoc.updated_at = new Date();
        await commentDoc.save();

        const profileId = await getSessionUserId(author, cid);
        if (!profileId) return res.status(404).json({ message: 'Profile not found.' });

        const promises = [
            ProfileComment.deleteOne({ profile_id: profileId, comment_id: comment })
        ];

        if (!commentDoc.parent) {
            promises.push(Post.decrementComment(commentDoc.post));
        }

        promises.push(userEventService.onCommentDeleted({
            req,
            commentDoc,
            profileId
        }));

        await Promise.all(promises);

        res.status(200).json({ message: 'Comment deleted successfully', commentId: commentDoc._id, entityId: commentDoc.entity });

    } catch (error) {
        next(error);
    }
};

/**
 * Reports a comment by the authenticated user.
 *
 * @async
 * @function reportComment
 * @param {import('express').Request} req - Express request object.
 * @param {string}  req.params.comment    - MongoDB ObjectId of the target comment.
 * @param {string}  req.body.reason       - Report category (e.g. "spam", "other").
 * @param {string}  [req.body.observation]- Optional free-text detail provided by the reporter.
 * @param {boolean} [req.body.blockUser]  - Whether the reporter also wants to block the comment author.
 * @param {string}  [req.body.source]     - Surface from which the report was triggered (e.g. "community").
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 * @returns {Promise<void>} Resolves with a JSON response indicating success.
 */
exports.reportComment = async (req, res, next) => {
    try {
        const { comment } = req.params;
        const { reason, observation, blockUser, source } = req.body;
        const author = req.user.author;
        const cid = req.cid;

        if (!mongoose.Types.ObjectId.isValid(comment)) {
            return res.status(400).json({ message: 'Invalid comment ID.' });
        }

        const commentDoc = await Comment.findById(comment).select('author post').lean();
        if (!commentDoc) {
            return res.status(404).json({ message: 'Comment not found.' });
        }

        const [reporterProfile, reportedProfile] = await Promise.all([
            profileService.getProfile(author, cid),
            profileService.getProfile(commentDoc.author, cid),
        ]);

        if (!reporterProfile || !reportedProfile) {
            return res.status(404).json({ message: 'Profile not found.' });
        }

        let report = await Report.findOne({ target_id: commentDoc._id, target_type: 'comment' });
        if (!report) {
            report = new Report({
                target_id:        commentDoc._id,
                target_type:      'comment',
                reported_profile: reportedProfile._id,
                context_id:       commentDoc.post,
                reports:          [],
            });
        }

        const existingReport = report.reports.some(
            (r) => r.profile_id.toString() === reporterProfile._id.toString()
        );

        const updates = [];

        if (!existingReport) {
            report.reports.push({
                profile_id:  reporterProfile._id,
                report_type: reason || 'other',
                reason:      observation || null,
                source:      source || null,
                created_at:  new Date(),
            });
            updates.push(report.save());
        }

        updates.push(profileService.deleteProfileCache(cid, author));

        let blockResult = false;
        if (blockUser) {
            blockResult = await profileService.blockMember(reporterProfile, reportedProfile, cid);
            if (blockResult) {
                updates.push(profileService.deleteProfileCache(cid, commentDoc.author));
            }
        }

        await Promise.all(updates);

        return res.status(200).json({
            message: 'Comment reported successfully.',
            blocked: blockUser && blockResult,
        });

    } catch (error) {
        next(error);
    }
};

exports.translateComment = async (req, res, next) => {
    try {
        const { comment } = req.params;
        const author = req.user.author;
        const cid = req.cid;
        const profile = await profileService.getProfile(author, cid);
        const targetLanguage = profile.locale || req.user?.locale?.substring(0, 2) || 'en';

        if (!mongoose.Types.ObjectId.isValid(comment)) return res.status(400).json({ message: 'Invalid comment ID.' });

        const commentDoc = await Comment.findById(comment);
        if (!commentDoc) return res.status(404).json({ message: 'Comment not found.' });

        const existingTranslation = commentDoc.translates.find(t => t.language === targetLanguage);
        if (existingTranslation) return res.status(200).json({ translation: existingTranslation.text });

        const translatedText = await translateService(commentDoc.text, targetLanguage);
        commentDoc.translates.push({ language: targetLanguage, text: translatedText, created_at: new Date() });
        await commentDoc.save();

        res.status(200).json({ translation: translatedText });

    } catch (error) {
        next(error);
    }
};

exports.getLikes = async (req, res, next) => {
    try {
        const cid = req.cid;
        const author = req.user?.author || null;

        if (req.query.commentIds) {
            let ids = [];
            try {
                ids = JSON.parse(req.query.commentIds);
            } catch (e) {
                return res.status(400).json({ message: 'Invalid commentIds format' });
            }

            const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
            
            if (validIds.length === 0) return res.status(200).json([]);

            const comments = await Comment.find({ _id: { $in: validIds } })
                .select('_id likesCount')
                .lean();

            const userLikesSet = new Set();
            if (author) {
                const currentProfileId = await getSessionUserId(author, cid);
                if (currentProfileId) {
                    const userLikes = await ProfileLike.find({
                        fk_id: { $in: validIds },
                        fk_type: 'comment',
                        profile_id: currentProfileId
                    }).select('fk_id').lean();

                    userLikes.forEach(l => userLikesSet.add(l.fk_id.toString()));
                }
            }

            const response = validIds.map(id => {
                const commentData = comments.find(c => c._id.toString() === id);
                
                return {
                    commentId: id,
                    likesCount: commentData ? (commentData.likesCount || 0) : 0,
                    authorLiked: userLikesSet.has(id)
                };
            });

            return res.status(200).json(response);
        }

        const targetId = req.params.commentId || req.params.entity;

        if (!mongoose.Types.ObjectId.isValid(targetId)) {
            return res.status(400).json({ message: 'Invalid comment ID.' });
        }

        const limit = 100;
        const cacheKey = `cid:${cid}:commentLikes:${targetId}:structure`;
        
        let response = await cacheService.get(cacheKey);
        let fromCache = !!response;

        if (!response) {
            const comment = await Comment.findById(targetId).select('likesCount').lean();
            if (!comment) return res.status(404).json({ message: 'Comment not found.' });

            const likes = await ProfileLike.aggregate([
                { $match: { fk_id: new mongoose.Types.ObjectId(targetId), fk_type: 'comment' } },
                { $sort: { created_at: -1 } },
                { $lookup: { from: 'profiles', localField: 'profile_id', foreignField: '_id', as: 'profile' } },
                { $unwind: { path: '$profile', preserveNullAndEmptyArrays: false } },
                { $match: { 'profile.cid': cid } },
                { $limit: limit },
                {
                    $project: {
                        _id: 0,
                        profileId: '$profile._id',
                        author: '$profile.author',
                        name: { $ifNull: ['$profile.name', 'Unknown'] },
                        given_name: { $ifNull: ['$profile.given_name', 'Unknown'] },
                        family_name: { $ifNull: ['$profile.family_name', 'Unknown'] },
                        picture: { $ifNull: ['$profile.picture', ''] },
                        created_at: { $ifNull: ['$profile.created_at', new Date()] }
                    }
                }
            ]);

            response = {
                commentId: targetId,
                totalLikes: comment.likesCount || 0,
                displayedLikes: likes.length,
                likes: likes
            };
            
            await cacheService.set(cacheKey, response, 3600);
        }

        if (author && response.likes.length > 0) {
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

                response = {
                    ...response,
                    likes: response.likes.map(like => ({
                        ...like,
                        isFollowing: followingSet.has(like.profileId.toString()),
                        isFollower: followerSet.has(like.profileId.toString()),
                        isFollowRequestSent: pendingSet.has(like.profileId.toString())
                    }))
                };
            }
        }

        if (fromCache) res.setHeader('X-Cache-App', 'HIT');
        res.status(200).json(response);

    } catch (error) {
        next(error);
    }
};

exports.getCommentAudio = async (req, res, next) => {
    try {
        const { comment } = req.params;
        if (!mongoose.Types.ObjectId.isValid(comment)) return res.status(400).json({ message: 'Invalid comment ID.' });

        const commentObject = await Comment.findOne({ _id: comment, visible: true }).select('_id hasAudio').lean();
        if (!commentObject) return res.status(404).json({ message: 'Comment not found or not visible.' });
        if (!commentObject.hasAudio) return res.status(404).json({ message: 'This comment does not have an audio.' });

        const commentAudio = await CommentAudio.findOne({ comment_id: comment }).select('audioData').lean();
        if (!commentAudio) return res.status(404).json({ message: 'Audio not found for this comment.' });

        res.status(200).json({ audio: commentAudio.audioData, commentId: comment });

    } catch (error) {
        res.status(500).json({ message: error.message || 'Internal server error.' });
    }
};

module.exports = exports;