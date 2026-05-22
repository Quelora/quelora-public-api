/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: packages/quelora-public-api/routes/routes.js */
// ./routes/routes.js
const { loadOptionalModule } = require('@quelora/common/utils/featureLoader');
const postRoutes = require('./postRoutes');
const commentRoutes = require('./commentRoutes');
const profileRoutes = require('./profileRoutes');
const ssoRoutes = require('./ssoRoutes');
const notificationsRoutes = require('./notificationsRoutes');
const authRoutes = require('./authRoutes');
const giphyRoutes = require('./giphyRoutes');

const validateClientHeader = require('@quelora/common/middlewares/validateClientHeaderMiddleware');
const extractGeoData = require('@quelora/common/middlewares/extractGeoDataMiddleware');
const trackUserPresence = require('@quelora/common/middlewares/trackUserPresence');
const optionalAuthMiddleware = require('@quelora/common/middlewares/optionalAuthMiddleware');
const { globalRateLimiter } = require('@quelora/common/middlewares/rateLimiterMiddleware');
const { getClientWidgetConfig } = require('@quelora/common/services/clientConfigService');


const Enterprise = loadOptionalModule('@quelora/enterprise');

const resilienceBootstrap = Enterprise?.resilienceBootstrapMiddleware || ((req, res, next) => next());
const captureAnonymousPeer = Enterprise?.captureAnonymousPeerMiddleware || ((req, res, next) => next()) ;

const standardMiddleware = [
    validateClientHeader,
    extractGeoData,
    trackUserPresence
];

const notificationsMiddleware = [
    validateClientHeader,
    trackUserPresence
];

module.exports = (app) => {

    app.get('/health',
            validateClientHeader,
            optionalAuthMiddleware,
            extractGeoData,
            resilienceBootstrap,
            captureAnonymousPeer,
            (req, res) => {
                res.status(200).json({
                    status: 'ok',
                    uptime: process.uptime(),
                    timestamp: Date.now(),
                    p2p_enabled: !!Enterprise
                });
        });

    app.get('/config',
            validateClientHeader,
            globalRateLimiter,
            async (req, res, next) => {
                try {
                    const config = await getClientWidgetConfig(req.cid);
                    if (!config) return res.status(404).json({ error: 'Client configuration not found' });
                    res.status(200).json(config);
                } catch (error) {
                    next(error);
                }
            });

    app.use('/sso', ssoRoutes);
    app.use('/profile', standardMiddleware, profileRoutes);
    app.use('/posts', standardMiddleware, postRoutes);
    app.use('/comments', standardMiddleware, commentRoutes);
    app.use('/auth', standardMiddleware, authRoutes);
    app.use('/notifications', notificationsMiddleware, notificationsRoutes);
    app.use('/giphy', standardMiddleware, giphyRoutes);
    
    if (Enterprise) {
        app.use('/surveys', standardMiddleware, Enterprise.surveyRoutes);
        app.use('/gamification', standardMiddleware, Enterprise.gamificationRoutes);
        app.use('/gamification', standardMiddleware, Enterprise.gamificationStoreRoutes);
        app.use('/ads', standardMiddleware, Enterprise.adRoutes);
        app.use('/notifications', notificationsMiddleware, Enterprise.sseRoutes);
        app.use('/p2p', standardMiddleware, Enterprise.p2pRoutes);
    }
};