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

// Telegram
{ "name": "Bot Alert", "type": "telegram", "config": { "bot_token": "123:ABC...", "chat_id": "-100123" } }
```

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
