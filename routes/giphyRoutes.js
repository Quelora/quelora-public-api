/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: packages/quelora-public-api/routes/giphyRoutes.js */
const express = require('express');
const router = express.Router();
const giphyController = require('../controllers/giphyController');
const { globalRateLimiter, strictRateLimiter } = require('@quelora/common/middlewares/rateLimiterMiddleware');
const optionalAuthMiddleware = require('@quelora/common/middlewares/optionalAuthMiddleware');
const responseCompressor = require('@quelora/common/middlewares/responseCompressor');
 
router.get('/search',   [globalRateLimiter, strictRateLimiter, optionalAuthMiddleware, responseCompressor], giphyController.searchGifs);
router.get('/trending', [globalRateLimiter, strictRateLimiter, optionalAuthMiddleware, responseCompressor], giphyController.trendingGifs);
 
module.exports = router;