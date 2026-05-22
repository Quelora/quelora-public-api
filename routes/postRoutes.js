/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

// ./routes/postRoutes.js
const express = require('express');
const router = express.Router();
const postController = require('../controllers/postController');
const authMiddleware = require('@quelora/common/middlewares/authMiddleware');
const optionalAuthMiddleware = require('@quelora/common/middlewares/optionalAuthMiddleware');
const responseCompressor = require('@quelora/common/middlewares/responseCompressor');

const { globalRateLimiter, strictRateLimiter } = require('@quelora/common/middlewares/rateLimiterMiddleware');

//Requiere tener token.
router.put('/:entity/like', [globalRateLimiter, strictRateLimiter, authMiddleware] , postController.likePost);
router.put('/:entity/share', [globalRateLimiter, strictRateLimiter, authMiddleware], postController.sharePost);


router.get('/:entity/thread', [ globalRateLimiter, strictRateLimiter, optionalAuthMiddleware, responseCompressor], postController.getEntityThread);
router.get('/:entity/replies/:commentId', [ globalRateLimiter, strictRateLimiter, optionalAuthMiddleware, responseCompressor], postController.getEntityReplies);
router.get('/stats', [ globalRateLimiter, strictRateLimiter, optionalAuthMiddleware, responseCompressor], postController.getPostStats);

router.get('/likes/:entity', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], postController.getPostLikes);
router.get('/:entity/nested', [ globalRateLimiter, strictRateLimiter, optionalAuthMiddleware, responseCompressor], postController.getNestedComments);

module.exports = router;