/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

// filepath: quelora/controllers/registrationController.js
/**
 * @module controllers/registrationController
 * @description Handles user registration, email verification, and password recovery flows.
 *
*/
'use strict';

const Profile = require('@quelora/common/models/Profile');
const { cacheService } = require('@quelora/common/services/cacheService');
const { addEmailJob } = require('@quelora/common/services/emailService');
const { generateToken } = require('@quelora/common/services/authService');
const i18n = require('@quelora/common/services/i18nService');
const verificationTemplate = require('@quelora/common/templates/emails/verificationTemplate');
const profileService = require('@quelora/common/services/profileService');
const { generateOnboardingSuggestions } = require('@quelora/common/services/onboardingService');

/** @constant {number} TTL in seconds for pending-verification cache entries. */
const REGISTRATION_TTL = 300;

/**
 * TTL in seconds for password-reset tokens.
 * Forwarded to `generateToken` so the issued JWT expires at the same wall-clock
 * time as the cache entry that gated its issuance.
 *
 * @constant {number}
 */
const RECOVERY_TOKEN_TTL = 600;

// =============================================================================
// REGISTRATION
// =============================================================================

/**
 * Initiates the email-verification step of the registration flow.
 *
 * Validates that the e-mail address is not already in use for the tenant,
 * generates a six-digit OTP, stores the pending profile data in cache, and
 * dispatches a localised verification e-mail.
 *
 * @async
 * @param {import('express').Request}  req              - Express request.
 * @param {string}  req.cid                             - Tenant identifier injected by middleware.
 * @param {string}  req.body.email                      - Candidate e-mail address.
 * @param {string}  req.body.name                       - Given name.
 * @param {string}  req.body.lastName                   - Family name.
 * @param {string}  req.body.password                   - Raw password (hashed by the Profile model pre-save hook).
 * @param {string}  req.body.country                    - ISO 3166-1 alpha-2 country code.
 * @param {string}  req.body.language                   - BCP-47 language tag.
 * @param {Object}  [req.body.settings]                 - Optional initial profile settings.
 * @param {import('express').Response} res              - Express response.
 * @returns {Promise<void>}
 */
exports.startRegistration = async (req, res) => {
    try {
        const { email, name, lastName, password, country, language, settings } = req.body;
        const cid = req.cid;

        const count = await Profile.collection.countDocuments(
            { email, cid },
            { limit: 1 }
        );

        if (count > 0) {
            return res.status(409).json({ error: '{{emailInUse}}' });
        }

        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

        const tempProfileData = { email, name, lastName, password, country, language, settings, verificationCode };

        const cacheKey = `pending-verification:${email}`;
        await cacheService.set(cacheKey, tempProfileData, REGISTRATION_TTL);

        const subject     = await i18n.getLocalizedMessage('verification.title', language);
        const messageBody = await i18n.getLocalizedMessage('verification.message', language, {
            name: name,
            verificationCode: verificationCode
        });
        const emailHtml = verificationTemplate({ title: subject, body: messageBody });

        await addEmailJob(cid, null, subject, emailHtml, email);

        return res.status(200).json({ message: 'success' });
    } catch (error) {
        console.error('Error in startRegistration:', error);
        return res.status(500).json({ error: '{{registrationError}}' });
    }
};

/**
 * Verifies the OTP supplied by the user and, on success, creates the profile
 * and issues an authentication token.
 *
 * The unique `name` for the new profile is resolved via
 * `Profile.generateUniqueName` before the document is instantiated. This
 * guarantees that the `pre('validate')` hook finds `this.name` already set and
 * skips its own check, and that the insert never hits an E11000 on the
 * collection-wide `name_1` index due to a stale uniqueness assumption.
 *
 * @async
 * @param {import('express').Request}  req              - Express request.
 * @param {string}  req.cid                             - Tenant identifier.
 * @param {string}  req.body.email                      - E-mail address used during registration.
 * @param {string}  req.body.code                       - Six-digit OTP entered by the user.
 * @param {import('express').Response} res              - Express response.
 * @returns {Promise<void>}
 */
exports.verifyCode = async (req, res) => {
    try {
        const { email, code } = req.body;
        const clientIp   = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const cid        = req.cid;
        const cacheKey   = `pending-verification:${email}`;

        const tempProfileData = await cacheService.get(cacheKey);
        if (!tempProfileData) {
            return res.status(200).json({ error: '{{codeExpired}}' });
        }

        if (tempProfileData.verificationCode !== code) {
            return res.status(200).json({ error: '{{verificationError}}' });
        }

        const uniqueName = await Profile.generateUniqueName(
            tempProfileData.email,
            `${tempProfileData.name || ''}${tempProfileData.lastName || ''}`
        );

        const newProfile = new Profile({
            cid,
            name:        uniqueName,
            email:       tempProfileData.email,
            password:    tempProfileData.password,
            given_name:  tempProfileData.name,
            family_name: tempProfileData.lastName,
            country:     tempProfileData.country,
            locale:      tempProfileData.language,
            settings:    tempProfileData.settings,
        });

        await newProfile.save();
        await cacheService.delete(cacheKey);

        generateOnboardingSuggestions(newProfile.author, cid).catch(
            err => console.error('Error triggering onboarding suggestions:', err.message)
        );

        const token = await generateToken(
            newProfile._id.toString(),
            newProfile.author,
            clientIp,
            false,
            cid
        );

        const profile = await profileService.getProfile(newProfile.author, cid);

        return res.status(201).json({
            message:   'Account created successfully.',
            token:     token,
            profile:   profile,
            expiresIn: process.env.JWT_TTL || '1h',
        });
    } catch (error) {
        console.error('Error in verifyCode:', error);
        return res.status(500).json({ error: '{{verificationError}}' });
    }
};

// =============================================================================
// PASSWORD RECOVERY
// =============================================================================

/**
 * Initiates the password-recovery flow.
 *
 * Looks up the profile by e-mail and tenant, generates an OTP, stores it in
 * cache, and dispatches a localised recovery e-mail.
 *
 * A generic success response is returned even when the e-mail is not found to
 * prevent user enumeration. The error key `{{profileNotFound}}` is preserved for
 * internal consistency but is intentionally indistinguishable from success on
 * the wire.
 *
 * @async
 * @param {import('express').Request}  req              - Express request.
 * @param {string}  req.cid                             - Tenant identifier.
 * @param {string}  req.body.email                      - E-mail address to recover.
 * @param {import('express').Response} res              - Express response.
 * @returns {Promise<void>}
 */
exports.startPasswordRecovery = async (req, res) => {
    try {
        const { email } = req.body;
        const cid       = req.cid;

        const profile = await Profile.findOne({ email, cid });
        if (!profile) {
            return res.status(200).json({ error: '{{profileNotFound}}' });
        }

        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const cacheKey         = `password-recovery-code:${email}`;
        await cacheService.set(cacheKey, verificationCode, REGISTRATION_TTL);

        const language    = profile.locale || 'en';
        const subject     = await i18n.getLocalizedMessage('recovery.title', language);
        const messageBody = await i18n.getLocalizedMessage('recovery.message', language, {
            name: profile.given_name || 'User',
            verificationCode: verificationCode
        });
        const emailHtml = verificationTemplate({ title: subject, body: messageBody });

        await addEmailJob(cid, null, subject, emailHtml, email);

        return res.status(200).json({ message: 'Password recovery code sending initiated.' });
    } catch (error) {
        console.error('Error in startPasswordRecovery:', error);
        return res.status(500).json({ error: '{{recoveryError}}' });
    }
};

/**
 * Validates the recovery OTP and issues a short-lived password-reset JWT.
 *
 * Fixes applied:
 * - `await` added to `generateToken` call (BUG-1).
 * - `cid` forwarded correctly as the fifth argument instead of the
 *   invalid literal `'password_reset_scope'` (BUG-3).
 * - `ttlSeconds` forwarded as the sixth argument so the reset token
 *   expires after `RECOVERY_TOKEN_TTL` seconds (BUG-3).
 *
 * @async
 * @param {import('express').Request}  req              - Express request.
 * @param {string}  req.cid                             - Tenant identifier.
 * @param {string}  req.body.email                      - E-mail address being recovered.
 * @param {string}  req.body.code                       - Six-digit OTP entered by the user.
 * @param {import('express').Response} res              - Express response.
 * @returns {Promise<void>}
 */
exports.verifyRecoveryCodeAndGenerateToken = async (req, res) => {
    try {
        const { email, code } = req.body;
        const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const cid      = req.cid;
        const cacheKey = `password-recovery-code:${email}`;

        const storedCode = await cacheService.get(cacheKey);
        if (!storedCode) {
            return res.status(200).json({ error: '{{codeExpired}}' });
        }

        if (storedCode !== code) {
            return res.status(200).json({ error: '{{verificationError}}' });
        }

        await cacheService.delete(cacheKey);

        const profile = await Profile.findOne({ email, cid });
        if (!profile) {
            return res.status(200).json({ error: '{{profileNotFound}}' });
        }

        // FIX BUG-1: added `await`.
        // FIX BUG-3: `cid` is now the fifth argument (was `'password_reset_scope'`).
        //            `RECOVERY_TOKEN_TTL` is now the sixth argument `ttlSeconds`,
        //            which authService.generateToken accepts and applies.
        const resetToken = await generateToken(
            profile._id.toString(),
            profile.author,
            clientIp,
            false,
            cid,
            RECOVERY_TOKEN_TTL
        );

        return res.status(200).json({
            message:   'Verification successful. Password reset key generated.',
            resetToken: resetToken,
            expiresIn:  RECOVERY_TOKEN_TTL,
        });
    } catch (error) {
        console.error('Error in verifyRecoveryCodeAndGenerateToken:', error);
        return res.status(500).json({ error: '{{verificationError}}' });
    }
};

// =============================================================================
// PASSWORD RESET
// =============================================================================

/**
 * Applies a new password for the authenticated user.
 *
 * This endpoint is protected by `validatePasswordResetTokenMiddleware`, which
 * validates the short-lived reset JWT and injects `req.author` before this
 * handler is invoked.
 *
 * @async
 * @param {import('express').Request}  req              - Express request.
 * @param {string}  req.author                          - Author hash injected by reset-token middleware.
 * @param {string}  req.cid                             - Tenant identifier.
 * @param {string}  req.body.newPassword                - The new raw password (hashed by the Profile model pre-save hook).
 * @param {import('express').Response} res              - Express response.
 * @returns {Promise<void>}
 */
exports.resetPassword = async (req, res) => {
    try {
        const { newPassword } = req.body;
        const authorId        = req.author;
        const cid             = req.cid;

        const profile = await Profile.findOne({ author: authorId, cid });
        if (!profile) {
            return res.status(200).json({ error: '{{profileNotFound}}' });
        }

        profile.password = newPassword;
        await profile.save();

        return res.status(200).json({ message: 'Password updated successfully.' });
    } catch (error) {
        console.error('Error in resetPassword:', error);
        return res.status(500).json({ error: '{{resetError}}' });
    }
};