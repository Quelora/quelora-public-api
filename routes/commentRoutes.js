/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

// ./routes/commentRoutes.js
const express = require('express');
const router = express.Router();

const commentController = require('../controllers/commentController');
const authMiddleware = require('@quelora/common/middlewares/authMiddleware');
const captchaMiddleware = require('@quelora/common/middlewares/captchaMiddleware');
const responseCompressor = require('@quelora/common/middlewares/responseCompressor');
const { globalRateLimiter, strictRateLimiter } = require('@quelora/common/middlewares/rateLimiterMiddleware');

router.post('/:entity/comment', [globalRateLimiter, strictRateLimiter, authMiddleware, captchaMiddleware ], commentController.addComment);
router.post('/:entity/comment/:comment/reply',[globalRateLimiter, strictRateLimiter, authMiddleware, captchaMiddleware],commentController.addReply);

router.put('/:entity/comment/:comment/like', [globalRateLimiter, strictRateLimiter, authMiddleware], commentController.likeComment);
router.delete('/:entity/comment/:comment/delete', [globalRateLimiter, strictRateLimiter, authMiddleware ], commentController.deleteComment);
router.patch('/:entity/comment/:comment/edit', [globalRateLimiter, strictRateLimiter, authMiddleware], commentController.editComment);

router.post('/:entity/comment/:comment/report', [globalRateLimiter, strictRateLimiter, authMiddleware], commentController.reportComment);

router.get('/likes/:entity/comments/:commentId', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], commentController.getLikes);
router.get('/likes/:entity', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], commentController.getLikes);

router.get('/:entity/comment/:comment/translate', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], commentController.translateComment);

router.get('/audio/:comment', [globalRateLimiter, strictRateLimiter, authMiddleware, responseCompressor], commentController.getCommentAudio );

module.exports = router;