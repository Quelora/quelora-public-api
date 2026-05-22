/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* quelora/routes/authRoutes.js */
const express = require('express');
const router = express.Router();

const registrationController = require('../controllers/registrationController');
const { globalRateLimiter } = require('@quelora/common/middlewares/rateLimiterMiddleware');
const captchaMiddleware = require('@quelora/common/middlewares/captchaMiddleware');
const validateClientHeader = require('@quelora/common/middlewares/validateClientHeaderMiddleware');
const validatePasswordResetToken = require('@quelora/common/middlewares/validatePasswordResetTokenMiddleware');

router.post('/register', [validateClientHeader, globalRateLimiter, captchaMiddleware], registrationController.startRegistration);
router.post('/verify-code', [validateClientHeader, globalRateLimiter], registrationController.verifyCode);

router.post('/password/recover/start', [validateClientHeader, globalRateLimiter, captchaMiddleware], registrationController.startPasswordRecovery);
router.post('/password/recover/verify', [validateClientHeader, globalRateLimiter], registrationController.verifyRecoveryCodeAndGenerateToken);
router.post('/password/reset', [validateClientHeader, validatePasswordResetToken], registrationController.resetPassword);

module.exports = router;