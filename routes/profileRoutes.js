/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: packages/quelora-public-api/routes/profileRoutes.js */
// ./routes/profileRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');

const upload = multer({
    dest: path.join(__dirname, '../temp_uploads'),
    limits: { fileSize: 5 * 1024 * 1024 }
});

const profileController = require('../controllers/profileController');
const authMiddleware = require('@quelora/common/middlewares/authMiddleware');
const { globalRateLimiter, strictRateLimiter } = require('@quelora/common/middlewares/rateLimiterMiddleware');
const responseCompressor = require('@quelora/common/middlewares/responseCompressor');

// --- GET Routes ---
router.get('/get',[ globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.getProfile);
router.get('/:author/get',[ globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.getProfile);

// Mutuals Route (STRICT SESSION ONLY)
// Removed public access via /:author/mutuals
router.get('/mutuals', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.getMutuals);

router.get('/following/activities',[  globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.getActivities);
router.get('/:author/search', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.unifiedSearch);
router.get('/search-followers', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.searchNewFollowers);
router.get('/:mention/mention',[ globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.getMention);
router.get('/blocked',[ globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.getBlockedList);

// --- Write/Update Routes ---
router.post('/update-media', [globalRateLimiter, strictRateLimiter, authMiddleware, upload.any()], profileController.uploadProfileMedia);
router.patch('/settings', [globalRateLimiter, strictRateLimiter, authMiddleware], responseCompressor, profileController.updateProfileSettings);
router.patch('/:userId/follow/approve', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.approveFollowRequest);
router.patch('/update-fields', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.updateProfileFields);

router.post('/:entity/bookmark', [ globalRateLimiter, strictRateLimiter, authMiddleware , responseCompressor], profileController.toggleBookmark);
router.post('/:userId/follow', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.followUser);
router.post('/:userId/block', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.blockMember);
router.post('/:userId/report', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.reportMember);

// --- Delete Routes ---
router.delete('/:targetId/suggestion', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.dismissSuggestion);
router.delete('/:userId/follow', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.unfollowUser);
router.delete('/:userId/cancel-follow', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.cancelFollowRequest);
router.delete('/:userId/cancel-block', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], profileController.unBlockMember);

module.exports = router;