/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: app.js */

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const http = require('http'); 
const cors = require('cors');
const path = require('path');

// Enterprise
const { loadOptionalModule } = require('@quelora/common/utils/featureLoader')
const Enterprise = loadOptionalModule('@quelora/enterprise');

// Common Quelora modules
const helmetConfig = require('@quelora/common/config/helmetConfig');
const dynamicCorsConfig = require('@quelora/common/config/dynamicCorsConfig');
const connectDB = require('@quelora/common/db'); 

// Local modules
const setupRoutes = require('./routes/routes'); 

// Custom Middlewares
const requestLogger = require('@quelora/common/middlewares/requestLogger');
const cacheInvalidator = require('@quelora/common/middlewares/cacheInvalidator');
const globalErrorHandler = require('@quelora/common/middlewares/globalErrorHandler');

// --- Initialization ---

// Connect to the database
connectDB();

// Initialize Express app
const app = express();
const port = process.env.PORT;
const baseURL = process.env.BASE_URL;

// Trust the proxy for IPs
app.set('trust proxy', 2);

// --- Core Middlewares ---

// Serve static assets with open CORS
app.use('/assets', (req, res, next) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
    });
    express.static(path.join(__dirname, 'public/assets'))(req, res, next);
});

// Security headers
app.use(helmetConfig); 

// CORS handling
app.use(cors(dynamicCorsConfig));
app.options('*', cors(dynamicCorsConfig));

// Body parsers
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// --- Custom Middlewares ---

// Log all incoming requests
app.use(requestLogger);

// Automatically invalidate cache on data-mutating requests (POST, PUT, etc.)
app.use(cacheInvalidator);

// --- Application Setup ---

// Load all API routes
setupRoutes(app); 

// Global error handler (must be loaded AFTER routes)
app.use(globalErrorHandler);

// --- Server Startup ---

const server = http.createServer(app);

// --- Enterprise Services Init ---
// Esto fuerza la suscripción a Redis para SSE (Gamification/Notificaciones)
if (Enterprise) {
    try {
        // Forzamos la carga del archivo sseService.js para que ejecute
        // su línea "redisSubscriber.subscribe(...)"
        require('@quelora/enterprise/services/sseService');
        console.log('🔌 [Public API] Enterprise SSE Service initialized & Subscribed to Redis');
    } catch (error) {
        console.warn('⚠️ [Public API] Could not auto-init SSE Service:', error.message);
    }
}
// ============================================================

// --- Socket Startup ---
if (Enterprise && Enterprise.webSocketService) {
    console.log('🔌 Initializing Enterprise WebSocket Service...');
    Enterprise.webSocketService(server);
} else {
    console.log('⚠️ WebSocket Service not found (Enterprise module missing or disabled).');
}

server.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server running ${baseURL}`);
});