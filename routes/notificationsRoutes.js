/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notificationsController');
const authMiddleware = require('@quelora/common/middlewares/authMiddleware');
const validateClientHeader = require('@quelora/common/middlewares/validateClientHeaderMiddleware');

const { globalRateLimiter, strictRateLimiter } = require('@quelora/common/middlewares/rateLimiterMiddleware');

router.post('/subscribe', [globalRateLimiter, strictRateLimiter, validateClientHeader, authMiddleware], notificationsController.subscribeProfile);
router.post('/unsubscribe', [globalRateLimiter, strictRateLimiter, validateClientHeader, authMiddleware], notificationsController.unsubscribeProfile);
router.post('/validate', [globalRateLimiter, strictRateLimiter, validateClientHeader, authMiddleware], notificationsController.validateSubscription);

module.exports = router;    