# quelora-public-api

**Community-facing API for the [Quelora](https://github.com/Quelora) platform.**

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)

The end-user API behind the Quelora widget. Handles every public interaction:
authentication, SSO, posts, comments, profiles, follows, notifications and the
GIF proxy. Listens on port **3000**.

## Features

- **Auth & SSO** — email/OTP registration, password recovery, social login (Google, Facebook, Apple, X)
- **Content** — post threads, smart-ranked comments, nested replies, likes, shares
- **Profiles** — follow graph, blocks, bookmarks, settings, media upload
- **Moderation** — toxicity scoring and LLM content moderation on every comment
- **Notifications** — Web Push subscriptions, SSE stream
- **Multi-tenant** — every request is scoped by a Client ID (`cid`)
- **Enterprise-ready** — optional surveys, gamification, ads, P2P resilience; degrades cleanly to Community Edition when absent

## Requirements

- Node.js 20+ · MongoDB 4.4+ · Redis 6+

## Setup

```bash
npm install
cp .env.example .env      # fill in your values
npm start
```

See `.env.example` for the full configuration reference (database, JWT,
encryption key, moderation/translation API keys, VAPID, worker tuning).

## Architecture

Depends on [`@quelora/common`](https://github.com/Quelora/quelora-common) for
models, services and middlewares. Background work is dispatched to
[`quelora-worker`](https://github.com/Quelora/quelora-worker) and
[`quelora-jobs`](https://github.com/Quelora/quelora-jobs) via BullMQ.

## License

[AGPL-3.0-only](./LICENSE) — Copyright (C) 2026 Germán Zelaya.

Part of the **[Quelora](https://github.com/Quelora)** project.
