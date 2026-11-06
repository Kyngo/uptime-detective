# Architecture

## Overview

Uptime Detective is a monorepo application with three packages:

- **server** — Express.js API with check engine, scheduler, and notification dispatch
- **client** — Vue 3 SPA with real-time dashboard
- **shared** — TypeScript types shared between client and server

All three are managed via npm workspaces from the root `package.json`.

## System Diagram

```mermaid
graph LR
    subgraph Client
        A[Vue 3 SPA<br/>Dashboard]
        B[Public Status<br/>Pages]
        W[Telegram Mini App<br/>same SPA in WebView]
    end

    subgraph Server["Express.js API"]
        C[Scheduler<br/>node-cron]
        D[Check Engine<br/>HTTP / ICMP / DNS / TLS / TCP]
        E[Notifiers<br/>Webhook / Email / Slack / Discord / Telegram]
        G[Telegram Bot<br/>long polling + commands]
        F[(SQLite<br/>WAL mode)]
        C --> D
        D --> F
        D --> E
        G --> F
        G --> D
    end

    A <-->|WebSocket + REST| Server
    B -->|REST| Server
    W -->|REST| Server
    G <-->|Bot API| T[Telegram]
    T -->|Mini App initData| W
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vue 3, Vite 6, Pinia, Vue Router, Chart.js, Tailwind CSS |
| Backend | Express.js 4, TypeScript 5.7, Socket.IO 4 |
| Database | SQLite (better-sqlite3, WAL mode) |
| Scheduling | node-cron |
| Auth | JWT + API tokens (bcrypt password hashing) |
| Security | Helmet, express-rate-limit, CORS, CSP headers |
| Notifications | nodemailer (SMTP), native HTTP (webhooks, Slack, Discord, Telegram) |
| Telegram Bot | Native `fetch` against the Telegram Bot API, long polling (no webhook) |
| Container | Node 22 Alpine, multi-stage build, non-root user |

## Check Engine

The check engine is an in-process scheduler built on node-cron. Each active monitor gets its own cron job based on its configured interval.

### Check Flow

```mermaid
flowchart TD
    A[Scheduler triggers check] --> B[Execute check with timeout]
    B --> C{Check passed?}
    C -->|Yes| D[Record UP in checks table]
    C -->|No| E{Retries remaining?}
    E -->|Yes| F[Wait retry_interval] --> B
    E -->|No| G[Record DOWN in checks table]
    D --> H{Status changed?}
    G --> H
    H -->|Yes| I[Create/resolve incident]
    I --> M{Maintenance window<br/>or monitor muted?}
    M -->|Yes| N[Suppress notification]
    M -->|No| J[Fire notifications]
    J --> K[Emit Socket.IO event]
    N --> K
    H -->|No| K
```

### Status Transitions

| From | To | Action |
|------|----|--------|
| UP | DOWN | Create incident, notify (alert) |
| DOWN | UP | Resolve incident, notify (recovery) |
| UP | DEGRADED | TLS cert expiring within warning threshold |
| Any | MAINTENANCE | During active maintenance window |

Status codes in the database:
- `0` = DOWN
- `1` = UP
- `2` = DEGRADED
- `3` = MAINTENANCE

### Scheduler Internals

- Converts interval (seconds) to cron expression
- Each monitor has an independent job — no shared timer
- Jobs auto-start on server boot for all active monitors
- Creating/updating/deleting monitors dynamically adds/removes jobs
- Graceful shutdown stops all jobs before closing the process

## Telegram Bot

The bot runs in-process with the API server and uses Telegram's **long-polling** mode (no public webhook required):

```mermaid
flowchart LR
    A[Bot controller<br/>getUpdates long poll] --> B[Allow-list gate]
    B -->|allowed| C[Command handlers<br/>/status /add /mute ...]
    B -->|not allowed| D[Reply with user ID]
    C --> E[Monitor service<br/>same CRUD as HTTP API]
    C --> F[Mutes service]
    C --> G[Check engine<br/>/ping /restart]
    E --> H[(SQLite)]
    F --> H
    I[Mini App auth<br/>initData HMAC + JWT] --> H
```

- **Config** — one global bot token (`TELEGRAM_BOT_TOKEN` env or the `settings` table). The token is resolved in one place, never returned by the API and never logged.
- **Runtime** — a singleton controller starts after the database and scheduler are ready, registers the command list and (when a Mini App URL is configured) the chat menu button, then polls `getUpdates` with an in-memory offset. Errors back off (`1s → 2s → 5s → 10s → 30s`); a `409` conflict triggers one `deleteWebhook` and retry. Shutdown aborts the in-flight poll.
- **Allow list** — every message and callback is gated. Unknown users are tracked (`telegram_users`) but get only their own ID; allowed users are effectively admins.
- **Commands** — dispatcher handles messages and inline callbacks, with short-lived in-memory state for wizards and confirmations. Mutations call the same `monitor-service` as the REST API, so side effects (scheduler jobs, Socket.IO events) are identical.
- **Notifications** — the dispatcher checks maintenance windows and active mutes before dispatch; a `telegram` channel only stores a `chat_id` and uses the global token.
- **Mini App** — a public `POST /api/v1/telegram/webapp/auth` endpoint validates `initData` with an HMAC of the bot token and issues a normal JWT for a shadow local user, gated by the same allow list.

See [Telegram Bot](./telegram.md) for setup and the full command reference.

## Real-time Updates

Socket.IO broadcasts events to all connected dashboard clients:

| Event | Payload | When |
|-------|---------|------|
| `check:result` | Check result object | Every check completes |
| `monitor:created` | Monitor object | New monitor created |
| `monitor:updated` | Monitor object | Monitor config changed |
| `monitor:deleted` | `{ monitor_id }` | Monitor deleted |
| `incident:created` | Incident object | New downtime detected |
| `incident:resolved` | Incident object | Downtime resolved |

Clients subscribe on connect and receive all events globally.

## Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Max monitors | 500+ (single instance) |
| Check latency overhead | < 50ms per check dispatch |
| Data retention | Configurable (default: 90 days, auto-prune) |
| Dashboard load time | < 1s |
| Database size | ~100MB per 100 monitors at 60s interval for 90 days |
| Deployment | Single `docker-compose.yml` with one container |

## Future Considerations

- **Multi-node deployment** — Redis-backed scheduler for HA
- **Proxy support** — HTTP proxy config for monitors behind firewalls
- **IPv6** — Full support in ICMP and TCP checkers
- **Custom check scripts** — User-defined check logic (security implications)
- **PWA** — Mobile push notifications
- **Internationalization** — i18n for the dashboard
