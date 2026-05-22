/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: packages/quelora-public-api/controllers/giphyController.js */
/**
 * @module Controllers/Giphy
 * @description Handles GIF search and trending requests by proxying to the
 * Giphy API (or a compatible endpoint) server-side.
 *
 * @version 2.3.0 (Strict URL Parsing & Safe Query Param Merge)
 */

'use strict';

const { getClientGiphyConfig } = require('@quelora/common/services/clientConfigService');
const { cacheService }         = require('@quelora/common/services/cacheService');

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_SEARCH_URL = 'https://api.giphy.com/v1/gifs/search';
const DEFAULT_TRENDING_URL = 'https://api.giphy.com/v1/gifs/trending';

const PAGE_SIZE = 40;
const MAX_PAGES = 3;
const CONTENT_RATING = 'g';
const SEARCH_CACHE_TTL = 3600; // 1 hour
const TRENDING_CACHE_TTL = 900; // 15 minutes
const MAX_QUERY_LENGTH = 100;
const ALLOWED_OFFSETS = Array.from({ length: MAX_PAGES }, (_, i) => i * PAGE_SIZE);

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

async function _shortUrlHash(url) {
    const data   = new TextEncoder().encode(url);
    const buffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 8);
}

async function _resolveCredentials(cid) {
    let clientApiKey      = null;
    let clientSearchUrl   = null;
    let clientTrendingUrl = null;

    if (cid) {
        try {
            const clientGiphy = await getClientGiphyConfig(cid);
            if (clientGiphy) {
                clientApiKey      = clientGiphy.apiKey      || null;
                clientSearchUrl   = clientGiphy.searchUrl   || null;
                clientTrendingUrl = clientGiphy.trendingUrl || null;
            }
        } catch (err) {
            console.error(`[GiphyController] Failed to load client config for CID ${cid}:`, err.message);
        }
    }

    const resolvedSearch   = clientSearchUrl   || process.env.GIPHY_SEARCH_URL   || DEFAULT_SEARCH_URL;
    const resolvedTrending = clientTrendingUrl || process.env.GIPHY_TRENDING_URL || DEFAULT_TRENDING_URL;

    return {
        apiKey:            clientApiKey || process.env.GIPHY_API_KEY || null,
        searchUrl:         resolvedSearch,
        trendingUrl:       resolvedTrending,
        hasCustomSearch:   resolvedSearch   !== DEFAULT_SEARCH_URL,
        hasCustomTrending: resolvedTrending !== DEFAULT_TRENDING_URL,
    };
}

async function _searchCacheKey(query, offset, hasCustomSearch, searchUrl) {
    const safeOffset = Number(offset) || 0;
    if (!hasCustomSearch) {
        return `giphy:search:${query}:offset:${safeOffset}`;
    }
    const hash = await _shortUrlHash(searchUrl);
    return `giphy:search:${hash}:${query}:offset:${safeOffset}`;
}

async function _trendingCacheKey(hasCustomTrending, trendingUrl, offset) {
    const safeOffset = Number(offset) || 0;
    if (!hasCustomTrending) {
        return `giphy:trending:offset:${safeOffset}`;
    }
    const hash = await _shortUrlHash(trendingUrl);
    return `giphy:trending:${hash}:offset:${safeOffset}`;
}

function _normalizeGif(gif) {
    if (!gif || !gif.id || !gif.images) return null;

    const url =
        gif.images?.fixed_height_small?.url ||
        gif.images?.fixed_height?.url       ||
        gif.images?.original?.url           ||
        null;

    if (!url) return null;

    return {
        id:    gif.id,
        url,
        title: gif.title || '',
    };
}

async function _fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Giphy upstream error: ${response.status} ${response.statusText}`);
    }
    return response.json();
}

// =============================================================================
// HANDLERS
// =============================================================================

const searchGifs = async (req, res) => {
    try {
        const cid    = req.cid || null;
        const query  = String(req.query.q || '').trim().toLowerCase().substring(0, MAX_QUERY_LENGTH);
        const rawOffset = Array.isArray(req.query.offset) ? req.query.offset[0] : req.query.offset;
        const offset = parseInt(rawOffset ?? '0', 10);

        if (!query) {
            return res.status(400).json({ error: 'Missing required query parameter: q' });
        }

        if (!ALLOWED_OFFSETS.includes(offset)) {
            return res.status(400).json({
                error: `Invalid offset. Allowed values: ${ALLOWED_OFFSETS.join(', ')}`
            });
        }

        const credentials = await _resolveCredentials(cid);

        if (!credentials.apiKey) {
            console.error('[GiphyController] No API key available');
            return res.status(503).json({ error: 'GIF service unavailable' });
        }

        const cacheKey = await _searchCacheKey(query, offset, credentials.hasCustomSearch, credentials.searchUrl);
        const cached   = await cacheService.get(cacheKey).catch(() => null);
        if (cached) return res.json(cached);

        // ── SAFE URL CONSTRUCTION ──
        // Utiliza la API URL nativa para fusionar los parámetros limpiamente,
        // evitando el fallo del doble '?' si la URL de origen ya tenía query params.
        const upstreamUrl = new URL(credentials.searchUrl);
        upstreamUrl.searchParams.set('api_key', credentials.apiKey);
        upstreamUrl.searchParams.set('q', query);
        upstreamUrl.searchParams.set('limit', String(PAGE_SIZE));
        upstreamUrl.searchParams.set('offset', String(offset));
        upstreamUrl.searchParams.set('rating', CONTENT_RATING);
        upstreamUrl.searchParams.set('lang', 'en');

        const data   = await _fetchJson(upstreamUrl.toString());
        const gifs   = (data.data || []).map(_normalizeGif).filter(Boolean);
        const currentPage = offset / PAGE_SIZE;
        const result = {
            gifs,
            hasMore: currentPage < MAX_PAGES - 1 && gifs.length === PAGE_SIZE,
        };

        await cacheService.set(cacheKey, result, SEARCH_CACHE_TTL).catch(() => {});

        return res.json(result);

    } catch (err) {
        console.error('[GiphyController] searchGifs error:', err.message);
        return res.status(502).json({ error: 'Failed to fetch GIFs' });
    }
};

const trendingGifs = async (req, res) => {
    try {
        const cid    = req.cid || null;
        const rawOffset = Array.isArray(req.query.offset) ? req.query.offset[0] : req.query.offset;
        const offset = parseInt(rawOffset ?? '0', 10);

        if (!ALLOWED_OFFSETS.includes(offset)) {
            return res.status(400).json({
                error: `Invalid offset. Allowed values: ${ALLOWED_OFFSETS.join(', ')}`
            });
        }

        const credentials = await _resolveCredentials(cid);

        if (!credentials.apiKey) {
            console.error('[GiphyController] No API key available');
            return res.status(503).json({ error: 'GIF service unavailable' });
        }

        const cacheKey = await _trendingCacheKey(credentials.hasCustomTrending, credentials.trendingUrl, offset);
        const cached   = await cacheService.get(cacheKey).catch(() => null);
        if (cached) return res.json(cached);

        // ── SAFE URL CONSTRUCTION ──
        const upstreamUrl = new URL(credentials.trendingUrl);
        upstreamUrl.searchParams.set('api_key', credentials.apiKey);
        upstreamUrl.searchParams.set('limit', String(PAGE_SIZE));
        upstreamUrl.searchParams.set('offset', String(offset));
        upstreamUrl.searchParams.set('rating', CONTENT_RATING);

        const data        = await _fetchJson(upstreamUrl.toString());
        const gifs        = (data.data || []).map(_normalizeGif).filter(Boolean);
        const currentPage = offset / PAGE_SIZE;
        const result      = {
            gifs,
            hasMore: currentPage < MAX_PAGES - 1 && gifs.length === PAGE_SIZE,
        };

        await cacheService.set(cacheKey, result, TRENDING_CACHE_TTL).catch(() => {});

        return res.json(result);

    } catch (err) {
        console.error('[GiphyController] trendingGifs error:', err.message);
        return res.status(502).json({ error: 'Failed to fetch trending GIFs' });
    }
};

module.exports = { searchGifs, trendingGifs };