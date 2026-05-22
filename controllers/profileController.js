/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: packages/quelora-public-api/controllers/profileController.js */
/**
 * @fileoverview Profile Controller
 * @module controllers/profileController
 */

'use strict';

const Post = require('@quelora/common/models/Post');
const Activity = require('@quelora/common/models/Activity');
const Profile = require('@quelora/common/models/Profile');
const Report = require('@quelora/common/models/Report');
const ProfileBookmark = require('@quelora/common/models/ProfileBookmark');
const ProfileFollower = require('@quelora/common/models/ProfileFollower');
const ProfileFollowing = require('@quelora/common/models/ProfileFollowing');
const ProfileFollowRequest = require('@quelora/common/models/ProfileFollowRequest');
const ProfileNotInterested = require('@quelora/common/models/ProfileNotInterested');

const { getSessionUserId } = require('@quelora/common/utils/profileUtils');

const profileService = require('@quelora/common/services/profileService');
const userEventService = require('@quelora/common/services/userEventService');
const { getUserOnlineStatus, incrementActivityScore } = require('@quelora/common/services/activeUsersService');

// --- Enterprise Loading ---
const { loadOptionalModule } = require('@quelora/common/utils/featureLoader');
const Enterprise = loadOptionalModule('@quelora/enterprise');
const resilienceService = Enterprise?.resilienceService;
// ---------------------------

const path = require('path');
const fs = require('fs').promises;

/**
 * Validates password strength requirements server-side.
 * @param {string} password - The raw password string to validate.
 * @returns {boolean} True if all security criteria are met.
 * @private
 */
const validatePasswordStrengthServer = (password) => {
    const checks = {
        length:  password.length >= 8,
        lower:   /[a-z]/.test(password),
        upper:   /[A-Z]/.test(password),
        special: /[^a-zA-Z0-9\s]/.test(password),
    };
    return Object.values(checks).filter(Boolean).length === 4;
};

/**
 * Retrieves a user profile with full hydration.
 * Implements "Public-Only Binary Strategy" to prevent sensitive data leaks.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware.
 */
exports.getProfile = async (req, res, next) => {
    try {
        const { cid } = req;
        const requestUserAuthor = req.user?.author;
        const targetAuthor = req.params.author || requestUserAuthor;

        if (!targetAuthor) return res.status(400).json({ status: 'ok', message: 'Author not provided.' });

        const isSessionUser = (requestUserAuthor === targetAuthor);

        const useBinaryCache = !isSessionUser && !!resilienceService;
        const binaryCacheKey = `cid:${cid}:profile:${targetAuthor}:binary`;

        if (useBinaryCache) {
            if (await resilienceService.tryServeBinary(res, { key: binaryCacheKey, scope: 'public' })) {
                return;
            }
        }

        const [profile, presence] = await Promise.all([
            profileService.getProfile(targetAuthor, cid, {
                currentUser:       requestUserAuthor,
                includeRelations:  true,
                includeCounts:     true,
                includeSettings:   isSessionUser,
                includeActivity:   true,
                includeBookmarks:  true,
                includeSuggestions: true,
                payloadUser:       isSessionUser ? req.user : null,
                geoData:           req.geoData || null,
            }),
            getUserOnlineStatus(targetAuthor, cid),
        ]);

        incrementActivityScore(targetAuthor, cid, 1).catch(err => console.warn('Failed to increment activity:', err.message));

        const finalProfile = { ...profile, online: presence.online, lastSeen: presence.lastSeen };

        if (useBinaryCache) {
            const sent = await resilienceService.sendArtifact(res, {
                data:  { profile: finalProfile },
                cid,
                key:   binaryCacheKey,
                scope: 'public',
            });
            if (sent) return;
        }

        res.status(200).json({ status: 'ok', profile: finalProfile });
    } catch (error) {
        console.error('❌ Error retrieving profile:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error.' });
    }
};

/**
 * Retrieves the list of mutual followers (reciprocal) with online status.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.getMutuals = async (req, res, next) => {
    try {
        const { cid } = req;
        const { query, lastId } = req.query;
        const currentUser = req.user?.author;

        const result = await profileService.getMutuals(currentUser, cid, query, lastId);
        res.status(200).json(result);
    } catch (error) {
        console.error('Error fetching mutuals:', error);
        res.status(500).json({ status: 'error', message: error.message || 'Internal server error' });
    }
};

/**
 * Blocks a member by establishing a block relationship.
 * Invalidates caches for both blocker and blocked to update UI immediately.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.blockMember = async (req, res, next) => {
    try {
        const { author } = req.user;
        const { cid } = req;
        const { userId } = req.params;

        const [blockerId, blockedId] = await Promise.all([
            getSessionUserId(author, cid),
            getSessionUserId(userId, cid),
        ]);

        if (!blockerId || !blockedId) {
            return res.status(404).json({ success: false, message: 'Profile not found' });
        }

        const result = await profileService.blockMember(blockerId, blockedId, cid);
        if (!result) return res.status(400).json({ success: false, message: 'User already blocked' });

        await Promise.all([
            profileService.deleteProfileCache(cid, author),
            profileService.deleteProfileCache(cid, userId),
        ]);

        return res.status(200).json({ success: true, message: 'User blocked successfully', block: true, memberId: userId });
    } catch (error) {
        console.error('Error in blockMember:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * Removes a block relationship between two users.
 * Invalidates caches to restore visibility and relationship status.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.unBlockMember = async (req, res, next) => {
    try {
        const { author } = req.user;
        const { cid } = req;
        const { userId } = req.params;

        const [blockerId, blockedId] = await Promise.all([
            getSessionUserId(author, cid),
            getSessionUserId(userId, cid),
        ]);

        if (!blockerId || !blockedId) {
            return res.status(404).json({ success: false, message: 'Profile not found' });
        }

        const result = await profileService.unBlockMember(blockerId, blockedId, cid);
        if (!result) return res.status(400).json({ success: false, message: 'User not blocked' });

        await Promise.all([
            profileService.deleteProfileCache(cid, author),
            profileService.deleteProfileCache(cid, userId),
        ]);

        return res.status(200).json({ success: true, message: 'User unblocked successfully', block: false, memberId: userId });
    } catch (error) {
        console.error('Error in unBlockMember:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * Retrieves the list of blocked users for the current session.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.getBlockedList = async (req, res, next) => {
    try {
        const { author } = req.user;
        const { cid } = req;

        const blockerProfile = await profileService.getProfile(author, cid);
        if (!blockerProfile) return res.status(404).json({ success: false, message: 'Profile not found' });

        const blockedList = await profileService.getBlockedList(blockerProfile, cid);
        return res.status(200).json({ success: true, result: blockedList });
    } catch (error) {
        console.error('Error in getBlockedList:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * Updates a specific profile setting and forces a cache refresh.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.updateProfileSettings = async (req, res, next) => {
    const { key, value } = req.body;
    const { author } = req.user;
    const { cid } = req;
    try {
        if (!key || value === undefined) throw new Error('Invalid request');

        await Profile.updateSettings(cid, author, key, value);
        await profileService.deleteProfileCache(cid, author);

        const profile = await profileService.getProfile(author, cid, {
            currentUser:       author,
            includeRelations:  true,
            includeCounts:     true,
            includeSettings:   true,
            includeActivity:   true,
            includeBookmarks:  true,
            includeSuggestions: true,
            payloadUser:       req.user,
            geoData:           req.geoData || null,
            forceRefresh:      true,
        });

        res.status(200).json({ status: 'ok', profile });
    } catch (error) {
        console.error('❌ Error updating profile settings:', error);
        res.status(500).json({ status: 'error', message: 'Internal Server Error.' });
    }
};

/**
 * Updates core identity fields of a profile.
 * Requires full document access for password comparison and atomic saves.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.updateProfileFields = async (req, res, next) => {
    const { name, given_name, family_name, password, password_original, vaultPepper } = req.body;
    const { author } = req.user;
    const { cid } = req;
    
    try {
        const profile = await Profile.findOne({ author, cid }).select('+password');
        if (!profile) return res.status(200).json({ success: false, message: 'Profile not found.' });

        let hasChanges = false;

        if (name && name !== profile.name) {
            if (!/^[a-zA-Z0-9]{3,15}$/.test(name)) {
                return res.status(200).json({ success: false, message: 'Invalid username format.' });
            }
            const existing = await Profile.exists({ name, cid });
            if (existing) return res.status(200).json({ success: false, message: 'Username is already taken.' });

            profile.name = name;
            hasChanges = true;
        }

        if (given_name !== undefined && given_name !== profile.given_name) {
            profile.given_name = given_name;
            hasChanges = true;
        }
        if (family_name !== undefined && family_name !== profile.family_name) {
            profile.family_name = family_name;
            hasChanges = true;
        }

        if (password) {
            if (!password_original) return res.status(200).json({ success: false, message: 'Current password required.' });
            if (!(await profile.comparePassword(password_original))) return res.status(200).json({ success: false, message: 'Current password incorrect.' });
            if (!validatePasswordStrengthServer(password)) return res.status(200).json({ success: false, message: 'Password too weak.' });

            profile.password = password;
            hasChanges = true;
        }

        if (vaultPepper) {
            if (!/^[a-f0-9]{64}$/i.test(vaultPepper)) {
                return res.status(400).json({ success: false, message: 'Invalid vaultPepper format. Expected SHA-256 hex string.' });
            }
            profile.vaultPepper = vaultPepper;
            hasChanges = true;
        }

        if (!hasChanges) return res.status(200).json({ success: true, message: 'No changes detected.' });

        profile.updated_at = Date.now();
        await profile.save();
        await profileService.deleteProfileCache(cid, author);

        const response = await profileService.getProfile(author, cid, {
            currentUser:      author,
            includeRelations: true,
            includeCounts:    true,
            includeSettings:  true,
            includeActivity:  true,
            includeBookmarks: true,
            includeSuggestions: true,
            forceRefresh:     true,
            geoData:          req.geoData || null,
        });

        return res.status(200).json({ success: true, message: 'Profile updated successfully.', profile: response });
    } catch (error) {
        console.error('❌ Error updating profile fields:', error);
        return res.status(500).json({ success: false, message: error.message || 'Internal Server Error.' });
    }
};

/**
 * Handles profile media uploads (avatars/backgrounds).
 * @param {Object} req - Express request object containing files.
 * @param {Object} res - Express response object.
 */
exports.uploadProfileMedia = async (req, res, next) => {
    const { author } = req.user;
    const { cid } = req;
    const file = req.files && req.files[0];

    if (!file) {
        return res.status(400).json({ status: 'error', message: 'No image file provided.' });
    }

    try {
        const profile = await Profile.findOne({ author, cid });
        if (!profile) return res.status(404).json({ status: 'ok', message: 'Profile not found.' });

        const fieldName = file.fieldname;
        if (!['picture', 'background'].includes(fieldName)) {
            await fs.unlink(file.path).catch(() => {});
            return res.status(400).json({ status: 'error', message: 'Invalid field name.' });
        }

        const subFolder = fieldName === 'picture' ? 'avatars' : 'backgrounds';
        const fileSystemUploadDir = path.join(__dirname, `../public/assets/${subFolder}`);

        await fs.mkdir(fileSystemUploadDir, { recursive: true });

        const extension = 'webp';
        const fileName = `${author}-${Date.now()}${fieldName === 'background' ? '.background' : ''}.${extension}`;
        const finalPath = path.join(fileSystemUploadDir, fileName);
        const publicUrlSegment = `/assets/${subFolder}`;

        try {
            await fs.rename(file.path, finalPath);
        } catch (error) {
            if (error.code === 'EXDEV') {
                await fs.copyFile(file.path, finalPath);
                await fs.unlink(file.path);
            } else {
                throw error;
            }
        }

        const baseUrl = process.env.BASE_URL || '';
        const publicUrl = `${baseUrl}${publicUrlSegment}/${fileName}`;

        profile[fieldName] = publicUrl;
        profile.updated_at = Date.now();

        await profile.save();
        await profileService.deleteProfileCache(cid, author);

        const updatedProfileObject = profile.toObject();
        const response = await profileService.getProfile(author, cid, {
            currentUser:      author,
            payloadUser:      updatedProfileObject,
            includeRelations: true,
            includeCounts:    true,
            includeSettings:  true,
            includeActivity:  true,
            includeBookmarks: true,
            forceRefresh:     true,
            geoData:          req.geoData || null,
        });

        res.status(200).json({ status: 'ok', message: 'Image uploaded successfully.', profile: response });
    } catch (error) {
        if (file) await fs.unlink(file.path).catch(() => {});
        console.error('❌ Error uploading profile media:', error);
        res.status(500).json({ status: 'error', message: 'Internal Server Error.' });
    }
};

/**
 * Retrieves a profile using a mention name (username).
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.getMention = async (req, res, next) => {
    try {
        const { mention } = req.params;
        const { cid } = req;
        const requestUserAuthor = req.user?.author;

        const mentionAuthor = await Profile.findOne({ name: mention, cid }).select('author').lean();
        if (!mentionAuthor) return res.status(200).json({ status: 'ok', message: 'Profile not found.' });

        const isSessionUser = (requestUserAuthor === mentionAuthor.author);

        const profile = await profileService.getProfile(mentionAuthor.author, cid, {
            currentUser:      requestUserAuthor,
            includeRelations: true,
            includeCounts:    true,
            includeSettings:  isSessionUser,
            includeActivity:  true,
            includeBookmarks: true,
            geoData:          req.geoData || null,
        });

        res.status(200).json({ status: 'ok', profile });
    } catch (error) {
        console.error('❌ Error retrieving mention:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error.' });
    }
};

/**
 * Initiates a follow relationship or request.
 * Requires target profile hydration to check for approval settings.
 * Invalidates cache to reflect follower counts or request status immediately.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.followUser = async (req, res, next) => {
    const targetId = req.params.userId;
    const { author } = req.user;
    const { cid } = req;

    try {
        const currentProfile = await profileService.getProfile(author, cid, { forceRefresh: true });
        if (currentProfile.author === targetId) return res.status(403).json({ status: 'ok', message: 'Cannot follow yourself.' });

        const profileToFollow = await profileService.getProfile(targetId, cid, { forceRefresh: true });
        if (!profileToFollow) return res.status(404).json({ status: 'ok', message: 'User does not exist.' });

        const isAlreadyFollowing = await ProfileFollowing.exists({ profile_id: currentProfile._id, following_id: profileToFollow._id });
        if (isAlreadyFollowing) return res.status(200).json({ status: 'ok', message: 'Already following.' });

        if (profileToFollow.followerApproval) {
            const existingRequest = await ProfileFollowRequest.findOne({ profile_id: currentProfile._id, target_id: profileToFollow._id, status: 'pending' });
            if (existingRequest) return res.status(200).json({ status: 'ok', message: 'Follow request already sent' });

            await ProfileFollowRequest.create({ profile_id: currentProfile._id, target_id: profileToFollow._id, status: 'pending', created_at: Date.now() });
            await profileService.removeSuggestion(currentProfile._id, profileToFollow._id);

            await userEventService.onFollowRequested({ req, currentProfile, targetProfile: profileToFollow });

            await Promise.all([
                profileService.deleteProfileCache(cid, author),
                profileService.deleteProfileCache(cid, targetId),
            ]);

            return res.status(200).json({ status: 'ok', message: 'Follow request sent', requiresApproval: true });
        } else {
            await Promise.all([
                ProfileFollowing.create({ profile_id: currentProfile._id, following_id: profileToFollow._id, created_at: Date.now() }),
                ProfileFollower.create({ profile_id: profileToFollow._id, follower_id: currentProfile._id, created_at: Date.now() }),
                profileService.removeSuggestion(currentProfile._id, profileToFollow._id),
            ]);

            await userEventService.onNewFollower({ req, currentProfile, targetProfile: profileToFollow });

            await Promise.all([
                profileService.deleteProfileCache(cid, author),
                profileService.deleteProfileCache(cid, targetId),
            ]);

            return res.status(200).json({ status: 'ok', message: 'You are now following this user', requiresApproval: false });
        }
    } catch (error) {
        console.error('Error in followUser:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error.' });
    }
};

/**
 * Terminates a follow relationship.
 * Invalidates cache to update counts on both sides.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.unfollowUser = async (req, res, next) => {
    const targetAuthor = req.params.userId;
    const { author } = req.user;
    const { cid } = req;

    try {
        const [currentProfileId, profileToUnfollowId] = await Promise.all([
            getSessionUserId(author, cid),
            getSessionUserId(targetAuthor, cid),
        ]);

        if (!profileToUnfollowId) return res.status(404).json({ status: 'ok', message: 'User not found.' });

        const isFollowing = await ProfileFollowing.findOne({ profile_id: currentProfileId, following_id: profileToUnfollowId });
        if (!isFollowing) return res.status(200).json({ status: 'ok', message: 'Not following.' });

        await Promise.all([
            isFollowing.deleteOne(),
            ProfileFollower.deleteOne({ profile_id: profileToUnfollowId, follower_id: currentProfileId }),
            profileService.removeSuggestion(currentProfileId, profileToUnfollowId),
        ]);

        await Promise.all([
            profileService.deleteProfileCache(cid, author),
            profileService.deleteProfileCache(cid, targetAuthor),
        ]);

        res.status(200).json({ status: 'ok', message: 'Unfollowed successfully.' });
    } catch (error) {
        console.error('Error unfollowing user:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error.' });
    }
};

/**
 * Cancels a pending follow request before approval.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.cancelFollowRequest = async (req, res, next) => {
    const targetId = req.params.userId;
    const { author } = req.user;
    const { cid } = req;

    try {
        const [currentProfileId, profileToCancelId] = await Promise.all([
            getSessionUserId(author, cid),
            getSessionUserId(targetId, cid),
        ]);

        if (!profileToCancelId) return res.status(404).json({ status: 'ok', message: 'User not found.' });

        const result = await ProfileFollowRequest.deleteOne({
            profile_id: currentProfileId,
            target_id:  profileToCancelId,
            status:     'pending',
        });

        if (result.deletedCount === 0) return res.status(404).json({ status: 'ok', message: 'No pending request found.' });

        await Promise.all([
            profileService.deleteProfileCache(cid, author),
            profileService.deleteProfileCache(cid, targetId),
        ]);

        return res.status(200).json({ status: 'ok', message: 'Follow request cancelled' });
    } catch (error) {
        console.error('Error in cancelFollowRequest:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error.' });
    }
};

/**
 * Approves or rejects an incoming follow request.
 * Hydrates both profiles as they are required for event notification metadata.
 * Invalidates cache on approval to update counts.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.approveFollowRequest = async (req, res, next) => {
    const userId = req.params.userId;
    const { author } = req.user;
    const { approve } = req.body;
    const { cid } = req;

    try {
        const [targetProfile, requestProfile] = await Promise.all([
            profileService.getProfile(author, cid),
            profileService.getProfile(userId, cid),
        ]);

        const followRequest = await ProfileFollowRequest.findOne({
            target_id:  targetProfile._id,
            profile_id: requestProfile._id,
            status:     'pending',
        }).populate('profile_id', 'author name picture');

        if (!followRequest) return res.status(404).json({ status: 'ok', message: 'Request not found' });

        if (approve) {
            await Promise.all([
                ProfileFollowing.create({ profile_id: followRequest.profile_id._id, following_id: targetProfile._id, created_at: Date.now() }),
                ProfileFollower.create({ profile_id: targetProfile._id, follower_id: followRequest.profile_id._id, created_at: Date.now() }),
            ]);
            followRequest.status = 'approved';

            await userEventService.onFollowApproved({ req, requestProfile, targetProfile });

            await Promise.all([
                profileService.deleteProfileCache(cid, author),
                profileService.deleteProfileCache(cid, userId),
            ]);
        } else {
            followRequest.status = 'rejected';
            await userEventService.onFollowRejected({ req, requestProfile, targetProfile });
        }

        followRequest.responded_at = Date.now();
        await followRequest.save();

        res.status(200).json({ status: 'ok', message: `Request ${approve ? 'approved' : 'rejected'}` });
    } catch (error) {
        console.error('Error processing follow request:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
};

/**
 * Toggles a bookmark for a post.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.toggleBookmark = async (req, res, next) => {
    const { entity } = req.params;
    const { author } = req.user;
    const { cid } = req;

    try {
        const [post, profile] = await Promise.all([
            Post.findOne({ entity }).select('_id title entity').lean(),
            profileService.getProfile(author, cid),
        ]);

        if (!post || !profile) return res.status(404).json({ status: 'ok', message: 'Post or Profile not found.' });

        const bookmark = await ProfileBookmark.findOne({ profile_id: profile._id, post_id: post._id });
        let attach = false;

        if (!bookmark) {
            await ProfileBookmark.create({ profile_id: profile._id, post_id: post._id, created_at: Date.now() });
            attach = true;
        } else {
            await bookmark.deleteOne();
        }

        await Promise.all([
            profileService.deleteProfileCache(cid, author),
            userEventService.onBookmarkToggled({ req, entity, post, profile, isAttached: attach }),
        ]);

        res.status(200).json({ status: 'ok', attach });
    } catch (error) {
        console.error('❌ Error toggling bookmark:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error.' });
    }
};

/**
 * Retrieves the activity feed for the specified profile.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.getActivities = async (req, res, next) => {
    try {
        const author = req.params.author || req.user.author;
        const { lastActivityTime, since } = req.query;
        const { cid } = req;

        if (!author) return res.status(400).json({ status: 'ok', message: 'Author not provided.' });

        const profileId = await getSessionUserId(author, cid);
        if (!profileId) return res.status(404).json({ status: 'ok', message: 'Profile not found.' });

        const following = await ProfileFollowing.find({ profile_id: profileId }).select('following_id').lean();
        const followingIds = following.map(f => f.following_id);

        const query = {
            profile_id: { $ne: profileId },
            $or: [
                { target_profile_id: { $in: followingIds }, action_type: { $ne: 'follow' } },
                { target_profile_id: profileId },
            ],
        };

        if (since) {
            query.created_at = { $gt: new Date(since) };
        } else if (lastActivityTime) {
            query.created_at = { $lt: new Date(lastActivityTime) };
        }

        const activities = await Activity.find(query).sort({ created_at: -1 }).limit(50).lean();

        const processedActivities = activities.map(activity => ({
            _id:         activity._id,
            action_type: activity.action_type,
            author:      { picture: activity.picture, author_username: activity.author_username, author: activity.author },
            entity:      activity.target,
            created_at:  activity.created_at,
            references:  activity.references,
        }));

        res.status(200).json({
            status:           'ok',
            activities:       processedActivities,
            lastActivityTime: processedActivities.length ? processedActivities[processedActivities.length - 1].created_at : null,
        });
    } catch (error) {
        console.error('Error getting following activities:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error.' });
    }
};

/**
 * Unified search interface for relationship lists and interaction history.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.unifiedSearch = async (req, res, next) => {
    const { author } = req.params;
    const { type, query, lastId } = req.query;
    const { cid } = req;
    const currentUser = req.user?.author;
    const validTypes = ['comments', 'likes', 'shares', 'follower', 'followed', 'bookmarks', 'blocked'];

    try {
        if (!type || !validTypes.includes(type)) return res.status(400).json({ status: 'error', message: 'Invalid search type' });

        const profile = await profileService.getProfile(author, cid);

        if (profile?.settings?.privacy?.showActivity === 'onlyme' && currentUser !== author) {
            if (!['follower', 'followed'].includes(type)) {
                return res.status(403).json({ status: 'error', message: 'Activity is private' });
            }
        }

        let result;
        switch (type) {
            case 'comments':  result = await profileService.getMoreComments(author, cid, query, currentUser, lastId);  break;
            case 'likes':     result = await profileService.getMoreLikes(author, cid, query, currentUser, lastId);     break;
            case 'shares':    result = await profileService.getMoreShares(author, cid, query, currentUser, lastId);    break;
            case 'follower':  result = await profileService.getMoreFollowers(author, cid, query, lastId, currentUser); break;
            case 'followed':  result = await profileService.getMoreFollowing(author, cid, query, lastId, currentUser); break;
            case 'bookmarks': result = await profileService.getMoreBookmarks(author, cid, query, currentUser, lastId); break;
            case 'blocked':   result = await profileService.getMoreBlocked(author, cid, query);                        break;
        }

        return res.json(result);
    } catch (error) {
        console.error('Error in unified search:', error);
        res.status(500).json({ status: 'error', message: error.message || 'Internal server error' });
    }
};

/**
 * Searches for profiles not yet followed by the current user.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.searchNewFollowers = async (req, res, next) => {
    const { query } = req.query;
    const { cid } = req;
    try {
        const response = await profileService.searchNewFollowers(req.user.author, cid, query, req.user.author);
        res.status(200).json(response);
    } catch (error) {
        console.error('Error searching new followers:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error.' });
    }
};

/**
 * Marks a suggested profile as not interesting to the current user.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
exports.dismissSuggestion = async (req, res, next) => {
    const { author } = req.user;
    const { cid } = req;
    const { targetId } = req.params;

    try {
        const [currentProfileId, targetProfileId] = await Promise.all([
            getSessionUserId(author, cid),
            getSessionUserId(targetId, cid),
        ]);

        if (!currentProfileId || !targetProfileId) return res.status(404).json({ status: 'ok', message: 'Profile not found.' });

        await ProfileNotInterested.updateOne(
            { profile_id: currentProfileId, target_id: targetProfileId },
            { $set: { created_at: new Date() } },
            { upsert: true }
        );

        await profileService.removeSuggestion(currentProfileId, targetProfileId);
        await profileService.deleteProfileCache(cid, author);

        res.status(200).json({ status: 'ok', message: 'Suggestion dismissed' });
    } catch (error) {
        console.error('Error dismissing suggestion:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
};

/**
 * Reports a user profile submitted by the authenticated user.
 *
 * Stores the report in the unified Report collection using target_type "profile".
 * Both `reported_profile` and `target_id` reference the accused Profile._id.
 * `context_id` is null since profiles have no parent entity.
 *
 * Accepted payload:
 * ```json
 * { "reason": "spam", "observation": "...", "blockUser": true, "source": "chat" }
 * ```
 *
 * @async
 * @function reportMember
 * @param {import('express').Request}  req                  - Express request object.
 * @param {string}  req.params.userId                       - Author hash of the profile being reported.
 * @param {string}  req.body.reason                         - Report category (spam|abuse|offensive|political|other).
 * @param {string}  [req.body.observation]                  - Optional free-text detail provided by the reporter.
 * @param {boolean} [req.body.blockUser]                    - Whether the reporter also wants to block the target.
 * @param {string}  [req.body.source]                       - Surface from which the report was triggered (e.g. "chat").
 * @param {import('express').Response} res                  - Express response object.
 * @param {import('express').NextFunction} next             - Express next middleware function.
 * @returns {Promise<void>} Resolves with a JSON response indicating success.
 */
exports.reportMember = async (req, res, next) => {
    try {
        const { userId } = req.params;
        const { reason, observation, blockUser, source } = req.body;
        const author = req.user.author;
        const cid = req.cid;

        if (author === userId) {
            return res.status(400).json({ message: 'Cannot report yourself.' });
        }

        const [reporterProfile, reportedProfile] = await Promise.all([
            profileService.getProfile(author, cid),
            profileService.getProfile(userId, cid),
        ]);

        if (!reporterProfile || !reportedProfile) {
            return res.status(404).json({ message: 'Profile not found.' });
        }

        let report = await Report.findOne({ target_id: reportedProfile._id, target_type: 'profile' });
        if (!report) {
            report = new Report({
                target_id:        reportedProfile._id,
                target_type:      'profile',
                reported_profile: reportedProfile._id,
                context_id:       null,
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
                updates.push(profileService.deleteProfileCache(cid, userId));
            }
        }

        await Promise.all(updates);

        return res.status(200).json({
            message: 'Member reported successfully.',
            blocked: blockUser && blockResult,
        });

    } catch (error) {
        next(error);
    }
};