# quelora-public-api — Developer Overview

**Stack:** Node.js · Express 4 · MongoDB · Redis · BullMQ
**Port:** 3000 (internal)
**Role in monorepo:** Main community-facing API. Handles all end-user interactions: authentication, SSO, posts, comments, profiles, follows, notifications, and GIF proxy. Enterprise module extends it with surveys, gamification, ads, SSE, and P2P.

---

## Directory Tree

```
quelora-public-api/
├── app.js                          # Entry point — Express init, DB, HTTP server, enterprise init
├── package.json
├── .env / .env.example
│
├── routes/
│   ├── routes.js                   # Aggregator — mounts all routers
│   ├── authRoutes.js               # Registration, password recovery
│   ├── ssoRoutes.js                # SSO verification + resilience header injection
│   ├── postRoutes.js               # Post thread, stats, likes, share
│   ├── commentRoutes.js            # Comment CRUD, likes, reports, translate, audio
│   ├── profileRoutes.js            # Profile CRUD, follow, block, bookmark, settings
│   ├── giphyRoutes.js              # GIF search/trending proxy
│   ├── notificationRoutes.js       # Push subscription management
│   └── healthRoutes.js             # Liveness probe
│
├── controllers/
│   ├── authController.js
│   ├── ssoController.js
│   ├── postController.js
│   ├── commentController.js
│   ├── profileController.js
│   ├── giphyController.js
│   └── notificationController.js
│
└── public/
    └── assets/                     # Static user-uploaded files (avatars, backgrounds)
        ├── avatars/
        └── backgrounds/
```

---

## Startup Sequence

```
app.js
  1. dotenv.config()
  2. connectDB()                     — MongoDB via @quelora/common/db
  3. Express + trust proxy (2 hops)
  4. /assets → static, open CORS    — public/assets/
  5. helmetConfig                    — security headers
  6. dynamicCorsConfig
  7. express.json (1 MB limit)
  8. requestLogger
  9. cacheInvalidator                — purge cache on POST/PUT/DELETE
  10. setupRoutes(app)
  11. globalErrorHandler
  12. Enterprise init (optional):
        sseService.init(server)
        websocketService.init(server)
  13. server.listen(PORT)
```

The Enterprise module (`@quelora/enterprise`) is loaded via `featureLoader` — if absent, the API starts normally as Community Edition.

---

## Middleware Chain

**Applied to all routes (inner order):**

| Middleware | What it does |
|-----------|-------------|
| `validateClientHeader` | Validates `X-Client-Id` header → populates `req.cid` |
| `extractGeoData` | Resolves IP → country/city/lat/lon → `req.geoData` |
| `trackUserPresence` | Updates Redis online status for authenticated users |
| `optionalAuthMiddleware` | Parses JWT if present → `req.user` (no rejection) |
| `authMiddleware` | Requires valid JWT → `req.user` or 401 |
| `globalRateLimiter` | 600 req/min per IP |
| `strictRateLimiter` | 10 req/2s per IP (writes, auth) |
| `captchaMiddleware` | Validates `x-captcha-token` header if enabled per client |
| `responseCompressor` | Dictionary-based payload compression |
| `validatePasswordResetToken` | Validates reset token (password recovery only) |

**Enterprise-only (injected when module present):**

| Middleware | Applied on |
|-----------|-----------|
| `resilienceBootstrapMiddleware` | `/health`, `/sso/verify`, thread, stats, profile |
| `captureAnonymousPeer` | `/health` |

---

## Route Map

### `/config`

```
GET /config
  Middleware: validateClientHeader, globalRateLimiter
  Response: public widget configuration for the client identified by X-Client-Id
```

Returns the complete bootstrap config consumed by the widget on startup via `bootstrapRemoteConfig()`. Built by `clientConfigService.getClientWidgetConfig(cid)`. Cached 1h in Redis.

**Response shape:**
```json
{
  "login":        { "queloraSession", "providers", "baseUrl", "loginUrl", "logoutUrl" },
  "captcha":      { "enabled", "provider", "siteKey" },
  "geolocation":  { "enabled", "provider", "apiKey" },
  "authWidget":   { ... },
  "language":     { ... },
  "entityConfig": {
    // Standard mode fields (omitted when deterministic: true):
    //   selector, entityIdAttribute, interactionPlacement.position, interactionPlacement.relativeTo, hrefAttribute
    // Always present:
    //   goTo, interactionPlacement.deterministic
    // Deterministic mode only: no selector/id/position fields; widget reads span.ql-deterministic markers
  },
  "features":     { "sse": true, "chat": true, "p2p": true, "interactionPlacer": true, ... },
  "audio":        { ... },
  "comments":     { ... },
  "vapid":        { "publicKey": "..." },
  "nostr":        { "relays": [...] },
  "trackerUrls":  [...],
  "plugins": {
    "ui":     [ { "name": "...", "path": "..." }, ... ],
    "worker": [ { "name": "...", "path": "..." }, ... ]
  }
}
```

`features` and `plugins` are built from `client.enterpriseModules` + `client.communityPlugins` via `buildPluginManifest()` from `pluginRegistry.js`. Only activated modules/plugins appear — an enterprise client with all modules enabled returns the full manifest; a community client returns only community plugins.

---

### `/health`

```
GET /health
  Middleware: validateClientHeader, optionalAuth, extractGeoData,
              resilienceBootstrap*, captureAnonymousPeer*
  Response: { status, uptime, timestamp, p2p_enabled }
```

---

### `/auth`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | none + captcha | Register user → send OTP email |
| POST | `/auth/verify-code` | none | Verify OTP → create account → return JWT |
| POST | `/auth/password/recover/start` | none | Send recovery OTP |
| POST | `/auth/password/recover/verify` | none | Verify OTP → return short-lived `resetToken` |
| POST | `/auth/password/reset` | `validatePasswordResetToken` | Set new password |

---

### `/sso`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/sso/verify` | none | Verify SSO credential (Google, Facebook, Apple, X, Quelora) → JWT |

**`/sso/verify` flow:**
1. `ssoService(cid, provider, credential)` → validates with provider
2. Generates community JWT (`JWT_SECRET`, 72h TTL)
3. **Enterprise:** decodes the new token, creates synthetic `req.user`, runs `resilienceBootstrapMiddleware` → injects `X-Resilience-Bootstrap` header in response
4. Returns `{ status, token, expires_in }`

---

### `/posts`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/posts/:entity/thread` | optional | Paginated root comments, smart-rank |
| GET | `/posts/:entity/replies/:commentId` | optional | Paginated replies for a comment |
| GET | `/posts/:entity/nested` | optional | Full nested reply tree (`$graphLookup` maxDepth 10) |
| GET | `/posts/stats` | optional | Batch stats for up to 40 entities |
| GET | `/posts/likes/:entity` | required | Top-100 likers with follow-relation hydration |
| PUT | `/posts/:entity/like` | required | Toggle post like |
| PUT | `/posts/:entity/share` | optional | Record post share |

**Thread endpoint details:**

- **Sort modes:** `smart` (ranking_score), `newest` (created_at desc), `oldest` (created_at asc), `top` (likesCount desc)
- **Compound cursor pagination** for score-based sorts:
  ```js
  $or: [
    { ranking_score: { $lt: lastScore } },
    { ranking_score: lastScore, _id: { $lt: lastId } }
  ]
  ```
- Cached 1h in Redis. Cache key includes `cid`, `entity`, `sort`, `lastCommentId`
- If authenticated: generates **sidecar** (liked/bookmarked state) cached 10min
- Hydrates comment authors with online status from `activeUsersService`
- **Enterprise:** tries binary resilience cache before JSON cache

**`/posts/stats` details:**

- Increments view count in Redis for all requested entities
- Enriches with survey status and ad flags if Enterprise is loaded
- Returns full `config` object (interaction flags, language, visibility)

---

### `/comments`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/comments/:entity/comment` | required + captcha | Create root comment |
| POST | `/comments/:entity/comment/:comment/reply` | required + captcha | Reply to comment |
| PATCH | `/comments/:entity/comment/:comment/edit` | required | Edit comment (time-limited) |
| DELETE | `/comments/:entity/comment/:comment/delete` | required | Soft-delete comment |
| PUT | `/comments/:entity/comment/:comment/like` | required | Toggle comment like |
| POST | `/comments/:entity/comment/:comment/report` | required | Report comment + optional block |
| GET | `/comments/likes/:entity/comments/:commentId` | required | Comment likers |
| GET | `/comments/likes/:entity` | required | Batch comment like data |
| GET | `/comments/:entity/comment/:comment/translate` | required | Translate comment to user locale |
| GET | `/comments/audio/:comment` | required | Fetch comment audio blob |

**Comment creation flow (`processCommentLogic`):**

```
1. Validate text length (config.limits.comment_text, default 200)
2. Detect language → languageService
3. Toxicity score → Perspective API (if configured)
     if score >= TOXICITY_THRESHOLD (0.7) → reject 400
4. Auto-translate if post language ≠ detected language (optional)
5. Profile.ensureProfileExists(req.user, cid, req.geoData)
6. Read trust_snapshot from profile: { level, initial_score }
7. calculateHotScore() → ranking_score
8. Create Comment { text, language, trust_snapshot, ranking_score, visible:true }
9. If audio: validate hash, store CommentAudio, set hasAudio:true
10. ProfileComment.create(...)
11. Post.incrementComment(postId)
12. userEventService.onCommentAdded(...)   ← triggers notifications, reputation, activity
```

**Edit constraints:**
- `post.config.editing.allow_edits` must be true
- Within `edit_time_limit` minutes of creation (default 5)
- Cannot edit comments with audio

**Soft delete:** sets `visible = false`. Only decrements `post.commentCount` for root comments.

---

### `/profile`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/profile/get` | required | Own profile |
| GET | `/profile/:author/get` | optional | Other user's profile |
| GET | `/profile/mutuals` | required | Mutual followers |
| GET | `/profile/:author/search` | required | Search within user data (comments, likes, followers…) |
| GET | `/profile/following/activities` | required | Activity feed from followed users |
| GET | `/profile/search-followers` | required | Search users not yet followed |
| GET | `/profile/:mention/mention` | optional | Profile by username |
| GET | `/profile/blocked` | required | List of blocked users |
| POST | `/profile/:userId/follow` | required | Follow or send follow request |
| DELETE | `/profile/:userId/follow` | required | Unfollow |
| PATCH | `/profile/:userId/follow/approve` | required | Approve/reject follow request |
| DELETE | `/profile/:userId/cancel-follow` | required | Cancel pending follow request |
| POST | `/profile/:userId/block` | required | Block user |
| DELETE | `/profile/:userId/cancel-block` | required | Unblock user |
| POST | `/profile/:entity/bookmark` | required | Toggle post bookmark |
| DELETE | `/profile/:targetId/suggestion` | required | Dismiss follow suggestion |
| POST | `/profile/update-media` | required + multer | Upload avatar or background (→ WebP) |
| PATCH | `/profile/settings` | required | Update single setting key/value |
| PATCH | `/profile/update-fields` | required | Update name, display name, or password |
| POST | `/profile/:userId/report` | required | Report user profile + optional block |

**Follow flow:**
- If `target.settings.privacy.followerApproval = true` → creates `ProfileFollowRequest` (pending) → `onFollowRequested`
- Otherwise → creates `ProfileFollowing` + `ProfileFollower` → `onNewFollower`

**Profile search types** (via `/profile/:author/search?type=X`):
`comments`, `likes`, `shares`, `follower`, `followed`, `bookmarks`, `blocked`
Respects `settings.privacy.showActivity` (`everyone` | `followers` | `onlyme`).

**Media upload:** converts to WebP via `imageHelper`, stores under `public/assets/{avatars|backgrounds}/{author}.webp`, updates `profile.picture` / `profile.background`.

---

### `/giphy`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/giphy/search` | required | Search GIFs (server-side privacy proxy, cached 1h) |
| GET | `/giphy/trending` | required | Trending GIFs (cached 15min) |

Query: `q`, `offset` (0/40/80 — max 3 pages). Response: `{ gifs: [{ id, url, title }], hasMore }`.

---

### `/notifications`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/notifications/subscribe` | required | Store push subscription in `profile.pushSubscriptions` |
| POST | `/notifications/unsubscribe` | required | Remove push subscription |
| POST | `/notifications/validate` | required | Check if subscription is still active |

---

### Enterprise routes (when `QUELORA_EDITION=enterprise`)

| Prefix | Router |
|--------|--------|
| `/surveys` | `Enterprise.surveyRoutes` |
| `/gamification` | `Enterprise.gamificationRoutes` + `gamificationStoreRoutes` |
| `/ads` | `Enterprise.adRoutes` |
| `/notifications` | `Enterprise.sseRoutes` (Server-Sent Events) |
| `/p2p` | `Enterprise.p2pRoutes` |

---

## Caching Strategy

| Data | TTL | Cache key pattern |
|------|-----|-------------------|
| Post thread | 1h | `cid:{cid}:thread:{entity}:{sort}:{lastId}` |
| Post replies | 1h | `cid:{cid}:thread:{entity}:{commentId}:{sort}:{lastId}` |
| Nested comments | 1h | `cid:{cid}:nested:{commentId}:{sort}` |
| Post stats | 1h | `cid:{cid}:stats:structure:{hash}` |
| Comment likes | 1h | `cid:{cid}:commentLikes:{commentId}:structure` |
| Post likes | 1h | `cid:{cid}:postLikes:{entity}:structure` |
| Giphy search | 1h | `giphy:search:{query}:offset:{n}` |
| Giphy trending | 15min | `giphy:trending:offset:{n}` |
| Profile sidecar (likes/bookmarks) | 10min | `cid:{cid}:sidecar:{profileId}:{hash}` |

`cacheInvalidator` middleware clears related keys on any POST/PUT/DELETE request automatically. Critical paths also call explicit `deleteByPattern` or `invalidateProfileCache`.

**Binary resilience cache (Enterprise):** same keys suffixed `:bin` — faster serialization for P2P sync.

---

## Resilience Bootstrap (`X-Resilience-Bootstrap`)

Injected by `resilienceBootstrapMiddleware` (Enterprise) on:
- `GET /health`
- `POST /sso/verify` (post-auth)
- `GET /posts/:entity/thread`, `GET /posts/stats` (optional)
- `GET /profile/get`, `GET /profile/:author/get` (optional)

The header contains a Base64-encoded payload with: P2P peer list, vault pepper, resilience mode for the client. The community widget reads this on startup to initialize its resilience subsystem.

---

## Worker / Jobs Integration

What this API **enqueues:**

| Trigger | Queue / Method | Consumer |
|---------|---------------|---------|
| Registration | `addEmailJob(...)` → `QUEUES.EMAILS` | quelora-worker |
| Password recovery | `addEmailJob(...)` → `QUEUES.EMAILS` | quelora-worker |
| Comment created | `userEventService.onCommentAdded(...)` | notification + activity workers |
| Reply created | `userEventService.onReplyAdded(...)` | notification + activity workers |
| Comment liked | `userEventService.onCommentLiked(...)` | reputation + notification workers |
| Post liked | `userEventService.onPostLiked(...)` | reputation + stats workers |
| Post shared | `userEventService.onPostShared(...)` | stats workers |
| Follow | `userEventService.onNewFollower(...)` | notification + activity workers |
| Follow request | `userEventService.onFollowRequested(...)` | notification workers |
| Registration complete | `generateOnboardingSuggestions(...)` | suggestion worker |
| View increment | `incrementPostViews(cid, entities)` | Redis counter (direct) |

All event dispatches use `Promise.allSettled` — a worker failure never blocks the HTTP response.

---

## Auth & JWT (Community Users)

Community users authenticate with `JWT_SECRET` (not `JWT_ADMIN_SECRET`). Token payload: `{ _id, author, sub, iat, exp, scope }`.

- `authMiddleware` → requires valid token → `req.user`
- `optionalAuthMiddleware` → tries to decode → `req.user` if valid, otherwise undefined
- No logout endpoint — tokens are stateless; expiry is the only invalidation
- `req.user.author` = SHA-256(email) — used as the stable user identity in all queries
- `req.user._id` / `req.user.sub` = Profile MongoDB `_id`

---

## Key Patterns

**Compound cursor pagination (score-based):**
Used on thread and replies to allow stable pagination even when `ranking_score` values are tied:
```js
$or: [
  { ranking_score: { $lt: lastScore } },
  { ranking_score: lastScore, _id: { $lt: lastId } }
]
```

**Sidecar data (lazy hydration):**
The authenticated user's like/bookmark state for a set of comments is fetched separately, cached 10min under a hash of all comment IDs. Avoids N+1 joins on every thread load.

**Trust snapshots:**
`comment.trust_snapshot = { level, initial_score }` captured at creation from the author's profile. Never updated. Ensures `calculateHotScore()` is deterministic for ranking regardless of future reputation changes.

**Atomic profile ensures:**
`Profile.ensureProfileExists(user, cid, geoData)` creates a profile if the user has never commented on this CID before. Geo is captured at first creation only.

**Presence hydration:**
`getUsersOnlineStatusBatch(authors[])` bulk-fetches Redis online status and merges it into comment author objects. Controlled by `activeUsersService`.

**Enterprise optional loading:**
```js
const Enterprise = featureLoader('@quelora/enterprise');
if (Enterprise?.resilienceBootstrapMiddleware) { ... }
```
All enterprise feature calls are guarded with optional chaining. The API degrades gracefully to Community Edition when the package is absent.

---

## Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=development
BASE_URL=https://api.quelora.dev
CLIENT_URL=https://demo.quelora.dev
DASHBOARD_URL=https://dashboard.quelora.dev

# Database / Cache
MONGO_URI=mongodb://mongo_db:27017/quelora
MONGO_SYNC_INDEXES=true
CACHE_REDIS_URL=redis://redis-internal:6379
CACHE_URL=redis://redis-internal:6379

# JWT
JWT_SECRET=...
JWT_TTL=72h
JWT_ADMIN_SECRET=...
JWT_ADMIN_TTL=72h

# Encryption
ENCRYPTION_KEY=...            # 64-char hex, AES-256-CBC

# Moderation / Toxicity
TOXICITY_THRESHOLD=0.7
PERSPECTIVE_API_URL=https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze
PERSPECTIVE_API_KEY=...

# Translation
TRANSLATE_API_URL=https://translation.googleapis.com/language/translate/v2
TRANSLATE_DETECT_API_URL=...
TRANSLATE_API_KEY=...
DEFAULT_LANGUAGE=es

# Language detection
DL_URL=https://ws.detectlanguage.com/0.2/detect
DL_API_KEY=...

# GIFs
GIPHY_API_KEY=...
GIPHY_SEARCH_URL=https://api.giphy.com/v1/gifs/search

# Push notifications (VAPID)
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_EMAIL=quelora@quelora.app

# BullMQ Worker
WORKER_CONCURRENCY=10
WORKER_MAX_JOBS_PER_SECOND=5000
WORKER_MAX_RETRIES=3
WORKER_BACKOFF_DELAY_MS=1000
WORKER_REMOVE_COMPLETED_JOBS=true
WORKER_REMOVE_FAILED_JOBS=1000

# Comments
LIMIT_COMMENTS=15             # Default page size

# Feature flags
DISABLE_RESPONSE_COMPRESSOR=0
RESILIENCE_FORCE_BOOTSTRAP=1  # Dev only: always inject resilience header
QUELORA_EDITION=enterprise    # or 'community'

# CID
CID=QU-XXXXXXXX-XXXXX
```

---

## Common Developer Tasks

**Add a new public endpoint:**
1. Create handler in the appropriate controller
2. Register in the matching `routes/*.js` — choose the right middleware stack (auth required? captcha? strict rate limit?)
3. If it returns cached data, define the cache key pattern and add invalidation where the underlying data changes

**Add a new user event:**
1. Add handler to `userEventService` in `@quelora/common`
2. Call it from the controller (fire-and-forget via `Promise.allSettled`)
3. If it needs a background worker job, add the BullMQ enqueue inside the handler

**Test comment creation without a real client:**
```bash
curl -X POST https://api.quelora.dev/comments/{entity}/comment \
  -H "Authorization: Bearer {jwt}" \
  -H "X-Client-Id: {cid}" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world"}'
```

**Debug resilience header:**
Check `RESILIENCE_FORCE_BOOTSTRAP=1` in `.env`. With this set, the header is always injected regardless of Enterprise module state. Inspect the `X-Resilience-Bootstrap` response header — it's Base64; decode it to inspect the P2P payload.

**Debug toxicity rejection:**
Lower `TOXICITY_THRESHOLD` in `.env` temporarily, or check the Perspective API response by adding a `console.log` in `processCommentLogic`. Scores are stored on the comment even when below threshold.
