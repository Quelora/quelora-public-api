/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

const express = require('express');
const router = express.Router();
const ssoController = require('../controllers/ssoController');

const { globalRateLimiter, strictRateLimiter } = require('@quelora/common/middlewares/rateLimiterMiddleware');

router.post('/verify', [globalRateLimiter, strictRateLimiter], ssoController.ssoVerify);

module.exports = router;    