# API Reference

Base URL: `/api/v1`

## Authentication

All authenticated endpoints require a `Bearer` token in the `Authorization` header:

```
Authorization: Bearer <token>
```

Two token types are supported:
- **JWT** — Issued on login, expires per `SESSION_EXPIRY` config (default: 7d)
- **API Token** — Long-lived, per-user, `ud_` prefix, generated from Settings

Both are validated by the same middleware.

---

## Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | No | Login, returns JWT |
| GET | `/auth/me` | Yes | Current user info |
| POST | `/auth/api-token` | Yes | Generate API token |
| DELETE | `/auth/api-token` | Yes | Revoke API token |
| PUT | `/auth/password` | Yes | Change password |

### POST /auth/login

```json
// Request
{ "username": "admin", "password": "..." }

// Response 200
{ "token": "eyJ...", "user": { "id": 1, "username": "admin", "role": "admin" } }
```

### PUT /auth/password

```json
// Request
{ "currentPassword": "...", "newPassword": "..." }

// Response 200
{ "message": "Password changed" }
```

---

## Monitors

| Method | Path | Description |
|--------|------|-------------|
| GET | `/monitors` | List all (supports `?group_id=`, `?tag=`, `?active=`) |
| GET | `/monitors/:id` | Detail with current status and metrics |
| POST | `/monitors` | Create |
| PUT | `/monitors/:id` | Update |
| DELETE | `/monitors/:id` | Delete (cascades checks/incidents) |
| POST | `/monitors/:id/pause` | Pause monitoring |
| POST | `/monitors/:id/resume` | Resume monitoring |
| GET | `/monitors/:id/checks` | Check history (`?from=`, `?to=`, `?limit=`, `?offset=`) |
| GET | `/monitors/:id/uptime` | Uptime percentage (`?days=`) |

### POST /monitors

```json
// Request
{
  "name": "My API",
  "type": "http",
  "target": "https://api.example.com/health",
  "interval": 60,
  "timeout": 10000,
  "retries": 2,
  "retry_interval": 30,
  "config": {
    "method": "GET",
    "accepted_status_codes": "200-299",
    "headers": {},
    "body": null,
    "body_match": null
  },
  "group_id": null,
  "tags": ["production", "api"],
  "active": true
}

// Response 201
{ "id": 1, "name": "My API", "type": "http", ... }
```

### GET /monitors/:id

Returns the monitor with enriched status fields:

```json
{
  "id": 1,
  "name": "My API",
  "type": "http",
  "target": "https://api.example.com/health",
  "current_status": "up",
  "last_check": { "status": 1, "response_time": 142, "created_at": "..." },
  "uptime_24h": 99.95,
  "avg_response_time": 156,
  ...
}
```

### GET /monitors/:id/checks

Query parameters:
- `from` — ISO datetime, filter checks after this time
- `to` — ISO datetime, filter checks before this time
- `limit` — Max results (default: 100)
- `offset` — Pagination offset

### GET /monitors/:id/uptime

Query parameters:
- `days` — Number of days to calculate (default: 30)

Returns: `{ "uptime": 99.95, "total_checks": 4320, "successful_checks": 4318 }`

---

## Groups

| Method | Path | Description |
|--------|------|-------------|
| GET | `/groups` | List groups (includes monitor counts) |
| POST | `/groups` | Create group |
| PUT | `/groups/:id` | Update group |
| DELETE | `/groups/:id` | Delete group (monitors become ungrouped) |

### POST /groups

```json
// Request
{ "name": "Production Services", "description": "Core production APIs" }

// Response 201
{ "id": 1, "name": "Production Services", "slug": "production-services", ... }
```

Slugs are auto-generated from the name. Duplicates get a numeric suffix.

---

## Status Pages

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status-pages` | List pages |
| POST | `/status-pages` | Create page |
| PUT | `/status-pages/:id` | Update page |
| DELETE | `/status-pages/:id` | Delete page |
| POST | `/status-pages/:id/items` | Add group/monitor to page |
| DELETE | `/status-pages/:id/items/:itemId` | Remove item |
| PUT | `/status-pages/:id/items/reorder` | Bulk reorder items |

### POST /status-pages

```json
// Request
{
  "title": "Acme Status",
  "slug": "acme",
  "description": "Current system status",
  "logo_url": "https://example.com/logo.png",
  "custom_css": "",
  "is_public": true
}
```

### POST /status-pages/:id/items

```json
// Add a group
{ "group_id": 1 }

// Or add an individual monitor
{ "monitor_id": 5 }
```

---

## Notifications

| Method | Path | Description |
|--------|------|-------------|
| GET | `/notifications` | List channels |
| POST | `/notifications` | Create channel |
| PUT | `/notifications/:id` | Update channel |
| DELETE | `/notifications/:id` | Delete channel |
| POST | `/notifications/:id/test` | Send test notification |
| POST | `/monitors/:mid/notifications/:nid` | Link channel to monitor |
| DELETE | `/monitors/:mid/notifications/:nid` | Unlink channel |
| GET | `/monitors/:mid/notifications` | List linked channels |

### POST /notifications

```json
// Webhook
{ "name": "PagerDuty", "type": "webhook", "config": { "url": "https://...", "secret": "hmac-key" }, "is_default": false }

// Slack
{ "name": "Ops Channel", "type": "slack", "config": { "webhook_url": "https://hooks.slack.com/..." }, "is_default": true }

// Email
{ "name": "Team Email", "type": "email", "config": { "to": "ops@example.com" }, "is_default": false }

// Discord
{ "name": "Alerts", "type": "discord", "config": { "webhook_url": "https://discord.com/api/webhooks/..." } }

// Telegram (bot token is instance-wide, configured in /telegram/config)
{ "name": "Bot Alert", "type": "telegram", "config": { "chat_id": "-100123" } }
```

---

## Telegram Bot

The bot is configured instance-wide. Mutation endpoints require the `admin` role; read endpoints require authentication. See [Telegram Bot](./telegram.md) for setup and command reference.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/telegram/config` | Yes | Current bot configuration and runtime status (never the full token) |
| PUT | `/telegram/config` | Admin | Save token / enabled state / Mini App URL and restart the bot |
| POST | `/telegram/restart` | Admin | Restart the bot and return its status |
| POST | `/telegram/test` | Admin | Send a test message through the global bot |
| GET | `/telegram/users` | Yes | List Telegram users known to the bot (allowed and pending) |
| POST | `/telegram/users` | Admin | Add/allow a Telegram user by numeric ID |
| PUT | `/telegram/users/:id` | Admin | Allow or deny a known Telegram user |
| DELETE | `/telegram/users/:id` | Admin | Deny a user (the row is kept, the user can be allowed again) |
| POST | `/telegram/webapp/auth` | **No** (signature) | Exchange Telegram Mini App `initData` for a JWT |

### GET /telegram/config

```json
{
  "enabled": true,
  "bot_token_set": true,
  "bot_token_hint": "12345678…:…wxyz",
  "bot_username": "acme_uptime_bot",
  "webapp_url": "https://status.example.com",
  "api_base_url": "https://api.telegram.org",
  "token_source": "settings",
  "status": {
    "configured": true,
    "enabled": true,
    "running": true,
    "bot_username": "acme_uptime_bot",
    "started_at": "2026-11-06T09:58:12.000Z",
    "last_error": null,
    "updates_processed": 42,
    "token_source": "settings"
  }
}
```

`token_source` is `env` when `TELEGRAM_BOT_TOKEN` is set, `settings` when the token is saved in the database, `none` otherwise. The token itself is never returned — only `bot_token_hint`.

### PUT /telegram/config

```json
// Request — every field optional
{
  "enabled": true,
  "bot_token": "123456789:AAH4k...",
  "webapp_url": "https://status.example.com"
}
```

Before saving, the server validates a new `bot_token` with Telegram `getMe` and rejects an invalid token (`400`). Sending `null` (or an empty string) clears the database token. When the token comes from the environment, changing or clearing it returns `400`. `webapp_url` must be a valid `https://` URL. Saving restarts the bot. Returns the same shape as `GET /telegram/config`.

### POST /telegram/restart

Restarts the long-polling bot and returns the runtime status:

```json
{
  "configured": true,
  "enabled": true,
  "running": true,
  "bot_username": "acme_uptime_bot",
  "started_at": "2026-11-06T10:00:00.000Z",
  "last_error": null,
  "updates_processed": 42,
  "token_source": "settings"
}
```

### POST /telegram/test

```json
// Request — chat_id optional; defaults to the first allowed user with a known chat
{ "chat_id": "-1001234567890" }

// Response 200
{ "message": "Test message sent to chat -1001234567890", "chat_id": "-1001234567890", "message_id": 42 }
```

Returns `400` when the bot is not configured or no allowed user with a chat is known; `502` when Telegram rejects the send.

### GET /telegram/users

```json
[
  {
    "telegram_user_id": 123456789,
    "chat_id": 123456789,
    "username": "alice_alerts",
    "first_name": "Alice",
    "last_name": null,
    "is_allowed": true,
    "allowed_by": 1,
    "last_seen_at": "2026-11-06T09:55:00.000Z",
    "created_at": "2026-11-05T18:00:00.000Z",
    "updated_at": "2026-11-06T09:55:00.000Z"
  }
]
```

Users that contacted the bot but are not allowed are listed with `is_allowed: false` (pending in the UI). `chat_id` is recorded only for private chats.

### POST /telegram/users

```json
// Request
{ "telegram_user_id": 123456789, "username": "alice_alerts", "is_allowed": true }

// Response 200 — the upserted record
{ "telegram_user_id": 123456789, "username": "alice_alerts", "is_allowed": true, ... }
```

`is_allowed: false` pre-denies the user in the same upsert. Returns `400` when `telegram_user_id` is not a positive integer.

### PUT /telegram/users/:id

```json
// Request
{ "is_allowed": false }

// Response 200 — updated record; 404 if the user is unknown
```

### DELETE /telegram/users/:id

Sets `is_allowed = 0`. The record is kept so the user can be allowed again.

```json
// Response 200
{ "message": "Telegram user denied", "user": { "telegram_user_id": 123456789, "is_allowed": false, ... } }
```

### POST /telegram/webapp/auth

**Public endpoint** (no `Authorization` header). Validates the Telegram Mini App `initData` HMAC signature with the bot token, checks `auth_date` freshness and the allow list, then issues a normal JWT.

```json
// Request
{ "init_data": "query_id=AAH...&user=%7B%22id%22%3A123...&auth_date=1762345000&hash=..." }

// Response 200
{
  "token": "eyJ...",
  "user": { "id": 7, "username": "tg_123456789", "role": "admin" },
  "telegram_user": { "id": 123456789, "username": "alice_alerts" }
}
```

Errors: `400` missing or malformed `init_data` (missing `init_data`, malformed query string, missing `hash`, `auth_date` or `user`, invalid user payload or user ID); `401` invalid signature, expired or future `auth_date`; `403` Telegram user not allowed; `503` bot not configured. Rate-limited to 20 requests per minute per IP.

---

## Maintenance Windows

| Method | Path | Description |
|--------|------|-------------|
| GET | `/maintenance` | List windows |
| POST | `/maintenance` | Create window |
| PUT | `/maintenance/:id` | Update window |
| DELETE | `/maintenance/:id` | Delete window |

### POST /maintenance

```json
{
  "title": "Database Migration",
  "description": "Upgrading PostgreSQL to v16",
  "start_at": "2026-07-20T02:00:00Z",
  "end_at": "2026-07-20T04:00:00Z",
  "recurring": null,
  "monitor_ids": [1, 3, 5]
}
```

`recurring` options: `null`, `"daily"`, `"weekly"`, `"monthly"`

---

## Public Endpoints (no auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status/:slug` | Public status page data |
| GET/POST | `/heartbeat/:token` | Push heartbeat |
| GET | `/health` | Health check |
| GET | `/setup/status` | Check if initial setup is needed |
| POST | `/setup/complete` | Complete initial setup (first-run only) |
| POST | `/telegram/webapp/auth` | Telegram Mini App login (signature-authenticated, see [above](#post-telegramwebappauth)) |

### GET /status/:slug

Returns the public status page with overall status calculation:

```json
{
  "title": "Acme Status",
  "overall_status": "operational",
  "sections": [
    {
      "group": { "name": "APIs", "slug": "apis" },
      "monitors": [
        {
          "name": "REST API",
          "current_status": "up",
          "uptime_90d": 99.98,
          "daily_uptimes": [...],
          "recent_incidents": [...]
        }
      ]
    }
  ]
}
```

Overall status values: `operational`, `degraded_performance`, `partial_outage`, `major_outage`, `maintenance`

### GET /health

```json
{ "status": "ok", "timestamp": "2026-07-16T12:00:00.000Z" }
```

---

## Error Responses

All errors follow a consistent format:

```json
{ "error": "Human-readable error message" }
```

Common HTTP status codes:
- `400` — Bad request (missing/invalid fields)
- `401` — Unauthorized (missing or invalid token)
- `403` — Forbidden (insufficient role)
- `404` — Resource not found
- `500` — Internal server error
