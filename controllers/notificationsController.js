/*
 * Quelora — quelora-public-api
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: app/controllers/notificationsController.js */
const Profile = require('@quelora/common/models/Profile');
const profileService = require('@quelora/common/services/profileService');

exports.subscribeProfile = async (req, res) => {
    try {
        const { subscriptionId, platform, permissionGranted, endpoint, keys } = req.body;
        const author = req.user.author;
        const cid = req.cid;

        if (!subscriptionId || !endpoint || !keys || !keys.p256dh || !keys.auth) {
            return res.status(400).json({ error: 'Incomplete subscription data' });
        }

        const subscriptionData = {
            subscriptionId,
            platform: platform || 'web',
            permissionGranted: permissionGranted !== false,
            endpoint,
            keys: {
                p256dh: keys.p256dh,
                auth: keys.auth
            },
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const profile = await profileService.getProfile(author, cid, {
            currentUser: req.user.author,
            includeSettings: true,
            includeNotifications: true,
            payloadUser: req.user
        });

        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        const existingSubIndex = profile.pushSubscriptions.findIndex(
            sub => sub.subscriptionId === subscriptionId
        );

        if (existingSubIndex >= 0) {
            await Profile.updateOne(
                { author, cid, 'pushSubscriptions.subscriptionId': subscriptionId },
                { $set: { 'pushSubscriptions.$': subscriptionData } }
            );
        } else {
            await Profile.updateOne(
                { author, cid },
                { $push: { pushSubscriptions: subscriptionData } }
            );
        }

        res.json({ success: true, message: existingSubIndex >= 0 ? 'Subscription updated' : 'Subscription created', subscriptionId });
    } catch (error) {
        console.error('Subscription error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.unsubscribeProfile = async (req, res) => {
    try {
        const { subscriptionId } = req.body;
        const author = req.user.author;
        const cid = req.cid;

        if (!subscriptionId) {
            return res.status(400).json({ error: 'subscriptionId required' });
        }

        const result = await Profile.updateOne(
            { author, cid },
            { $pull: { pushSubscriptions: { subscriptionId } } }
        );

        if (result.modifiedCount === 0) {
            return res.status(404).json({ error: 'Subscription not found' });
        }

        res.json({ success: true, message: 'Unsubscribed successfully' });

    } catch (error) {
        console.error('Unsubscribe error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.validateSubscription = async (req, res) => {
    try {
        const { subscriptionId } = req.body;

        if (!subscriptionId) {
            return res.status(400).json({ error: 'subscriptionId is required' });
        }

        const clientId = req.headers['x-client-id'];
        if (!clientId) {
            return res.status(400).json({ error: 'X-Client-Id header is required' });
        }

        const profile = await Profile.findOne({ 'pushSubscriptions.subscriptionId': subscriptionId });

        if (!profile) {
            return res.status(200).json({ active: false });
        }

        const subscription = profile.pushSubscriptions.find(sub => sub.subscriptionId === subscriptionId);

        if (!subscription || subscription.permissionGranted === false) {
            return res.status(200).json({ active: false });
        }

        res.status(200).json({ active: true });

    } catch (error) {
        console.error('validateSubscription error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};