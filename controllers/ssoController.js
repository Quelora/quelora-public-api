/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

// ./controllers/ssoController.js
const { ssoService } = require('@quelora/common/services/ssoService');
const { loadOptionalModule } = require('@quelora/common/utils/featureLoader');
const jwt = require('jsonwebtoken');

/**
 * Handles SSO verification requests from identity providers.
 * Intercepts the response post-authentication to optionally inject Resilience P2P anchors.
 * @param {Object} req - Express request object (expects req.headers['x-client-id'] and req.body.credential)
 * @param {Object} res - Express response object
 */
exports.ssoVerify = async (req, res) => {
    if (!req.body?.credential) {
        return res.status(400).json({  status: 'error',  message: 'Missing credential parameter' });
    }

    const { credential, provider } = req.body;
    const cid = req.headers['x-client-id'];
    
    if (!cid) {
      return res.status(400).json({ error: 'X-Client-Id header is required' });
    }

    try {
        const result = await ssoService(cid, provider, credential);

        if (result.status === 'success') {
            
            // 1. Dynamic check for Enterprise Module to maintain public-api decoupling
            const Enterprise = loadOptionalModule('@quelora/enterprise');
            
            if (Enterprise && typeof Enterprise.resilienceBootstrapMiddleware === 'function') {
                // 2. Decode the newly generated token to extract the user's author/sub ID
                const decoded = jwt.decode(result.token);
                
                if (decoded) {
                    // 3. Inject synthetic user context. 
                    // This allows the resilience middleware to fetch the user-specific vaultPepper from DB.
                    req.user = decoded; 
                    req.cid = cid; // Ensure CID is attached to the request object for the middleware
                    
                    // 4. Programmatic execution of the middleware.
                    // We wrap it in a Promise to block the thread until the headers are successfully injected.
                    await new Promise((resolve) => {
                        Enterprise.resilienceBootstrapMiddleware(req, res, resolve);
                    });
                }
            }

            // 5. Dispatch standard SSO response (now enriched with X-Resilience-Bootstrap headers if applicable)
            return res.json({ status: 'success', token: result.token, expires_in: result.expires_in });
        }

        // A failed SSO verification is an authentication rejection, not a successful response.
        // HTTP 401 is semantically correct and allows the client Worker to detect the failure
        // via the HTTP status code rather than inspecting the response body.
        // The `error_code` field provides a stable, locale-independent key that the frontend
        // i18n layer can map to a user-facing string without parsing free-text messages.
        return res.status( 401 ).json({
            status:     'error',
            error_code: result.error_code || 'SSO_VERIFICATION_FAILED',
            message:    result.message   || 'SSO verification failed'
        });

    } catch (error) {
        console.error('[SSO Controller] Authentication error:', error);
        return res.status(500).json({ status: 'error', message: 'Internal authentication error' });
    }
};