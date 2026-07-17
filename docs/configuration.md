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
| `ALLOW_PRIVATE_IPS` | `true` | Allow monitoring private/internal IPs (192.168.x, 10.x, 172.16.x) |

Set to `false` in multi-tenant environments to prevent SSRF-style abuse.

### Email (SMTP)

Required only if you use email notification channels.

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | — | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP port (587 for STARTTLS, 465 for SSL) |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |
| `SMTP_FROM` | — | Sender email address (e.g. `alerts@example.com`) |

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
```

Variables with `${VAR:-default}` syntax pull from the host environment or use the default. Set them in a `.env` file alongside `docker-compose.yml` or export them in your shell.
