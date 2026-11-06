# Configuration

## Environment Variables

All configuration is done through environment variables, typically via a `.env` file at the project root.

```bash
cp .env.example .env
```

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3300` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | `development` or `production` |

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `./data/uptime-detective.db` | Path to SQLite database file |

The directory is created automatically if it doesn't exist. Relative paths resolve from the project root (not CWD).

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | `change-me-to-a-random-string` | JWT signing secret |
| `SESSION_EXPIRY` | `7d` | JWT token expiry (e.g. `1h`, `7d`, `30d`) |

**Production requirement:** The server refuses to start in `NODE_ENV=production` with a known-insecure `JWT_SECRET`. Generate a strong one:

```bash
openssl rand -base64 32
```

### Monitoring

| Variable | Default | Description |
|----------|---------|-------------|
| `ALLOW_PRIVATE_IPS` | `false` | Allow checking private/internal IPs (192.168.x, 10.x, 172.16.x) from HTTP monitors and from the bot's `/ping` command |

When unset (default) or `false`, HTTP checks and bot `/ping` targets that resolve to loopback, private, link-local or cloud-metadata addresses are refused (SSRF protection). Set `ALLOW_PRIVATE_IPS=true` for self-hosted instances that monitor internal services (the sample `.env.example` enables it).

### Email (SMTP)

Required only if you use email notification channels.

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | — | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP port (587 for STARTTLS, 465 for SSL) |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |
| `SMTP_FROM` | — | Sender email address (e.g. `alerts@example.com`) |

### Telegram Bot

The Telegram bot is optional. Every variable below can also be set from the web UI (**Settings → Telegram Bot**); environment variables take precedence.

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from [@BotFather](https://t.me/BotFather). Overrides the token saved in the database; while set, the API cannot change or clear the token. A configured token is also what notification channels need. |
| `TELEGRAM_BOT_ENABLED` | `true` | Set to `false` (or `0`) to disable chat control: the long-polling bot does not start and commands are not handled. Notifications still work as long as a bot token is configured — the enable flag only controls polling. |
| `TELEGRAM_ADMIN_USER_IDS` | — | Comma-separated Telegram user IDs to allow automatically when the server starts (bootstrap allow list). |
| `TELEGRAM_API_BASE_URL` | `https://api.telegram.org` | Telegram Bot API base URL. Only change this for tests or a self-hosted Bot API server. |
| `TELEGRAM_WEBAPP_URL` | — | Public HTTPS URL of this instance for the [Telegram Mini App](./telegram.md#telegram-mini-app). Must use `https://` (validated). Wins over the web UI setting. |
| `TELEGRAM_WEBAPP_AUTH_MAX_AGE` | `86400` | Maximum age in seconds of Mini App `initData` (default 24 hours). |
| `APP_URL` | — | Public base URL of the instance (e.g. `https://status.example.com`). Used for monitor links in Telegram notifications and to make heartbeat URLs absolute in the bot's `/info` reply. |

```bash
# Example: bot token from the environment, first admin bootstrapped
TELEGRAM_BOT_TOKEN=123456789:AAH4k...
TELEGRAM_ADMIN_USER_IDS=123456789
APP_URL=https://status.example.com
```

See [Telegram Bot](./telegram.md) for setup, commands, the Mini App and troubleshooting.

## Security Settings

### JWT Secret Validation

On startup, the server checks `JWT_SECRET` against a list of known defaults:
- `change-me`
- `change-me-to-a-random-string`
- `dev-secret-change-me`
- `please-change-this-secret`

In development, this produces a warning. In production (`NODE_ENV=production`), the server exits immediately.

### Content Security Policy

Helmet enforces these CSP directives:

```
default-src: 'self'
connect-src: 'self' ws: wss:
style-src: 'self' 'unsafe-inline'
img-src: 'self' data: https:
script-src: 'self'
```

### CORS

- **Development:** Allows requests from `http://localhost:5173` (Vite dev server)
- **Production:** CORS disabled (SPA served from same origin)

### Rate Limiting

`express-rate-limit` is applied to authentication and public endpoints to prevent brute-force attacks.

## Docker Environment

When running via `docker-compose.yml`, environment variables are passed through:

```yaml
environment:
  - NODE_ENV=production
  - PORT=3300
  - HOST=0.0.0.0
  - DB_PATH=/app/data/uptime-detective.db
  - JWT_SECRET=${JWT_SECRET:-please-change-this-secret}
  - SESSION_EXPIRY=${SESSION_EXPIRY:-7d}
  - SMTP_HOST=${SMTP_HOST:-}
  - SMTP_PORT=${SMTP_PORT:-587}
  - SMTP_USER=${SMTP_USER:-}
  - SMTP_PASS=${SMTP_PASS:-}
  - SMTP_FROM=${SMTP_FROM:-}
  - APP_URL=${APP_URL:-}
  - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
  - TELEGRAM_BOT_ENABLED=${TELEGRAM_BOT_ENABLED:-true}
  - TELEGRAM_ADMIN_USER_IDS=${TELEGRAM_ADMIN_USER_IDS:-}
  - TELEGRAM_API_BASE_URL=${TELEGRAM_API_BASE_URL:-https://api.telegram.org}
  - TELEGRAM_WEBAPP_URL=${TELEGRAM_WEBAPP_URL:-}
  - TELEGRAM_WEBAPP_AUTH_MAX_AGE=${TELEGRAM_WEBAPP_AUTH_MAX_AGE:-86400}
```

Variables with `${VAR:-default}` syntax pull from the host environment or use the default. Set them in a `.env` file alongside `docker-compose.yml` or export them in your shell.
