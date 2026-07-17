# Deployment

## Docker (Recommended)

The simplest way to deploy Uptime Detective in production.

### Quick Start

```bash
# Generate a secure JWT secret
export JWT_SECRET=$(openssl rand -base64 32)

# Build and start
docker compose up --build -d
```

Open http://localhost:3300. The setup wizard guides you through creating your admin account.

### Docker Compose Configuration

```yaml
services:
  uptime-detective:
    build: .
    container_name: uptime-detective
    restart: unless-stopped
    ports:
      - "3300:3300"
    volumes:
      - uptime-data:/app/data
    tmpfs:
      - /tmp
    read_only: true
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
    cap_drop:
      - ALL
    cap_add:
      - NET_RAW  # Required for ICMP ping
    security_opt:
      - no-new-privileges:true

volumes:
  uptime-data:
```

### Multi-Stage Dockerfile

The build uses two stages:

1. **Builder** — Node 22 Alpine, installs all dependencies, compiles TypeScript, builds the Vue SPA
2. **Production** — Node 22 Alpine, production deps only, non-root `node` user, `iputils` for ping

Final image includes:
- Compiled server JavaScript (`server/dist/`)
- Built Vue SPA (`client/dist/`)
- Shared types package (`shared/dist/`)
- Production-only node_modules

### Security Hardening

| Feature | Purpose |
|---------|---------|
| `read_only: true` | Immutable filesystem (prevents tampering) |
| `tmpfs: /tmp` | Writable temp only in memory |
| `cap_drop: ALL` | Remove all Linux capabilities |
| `cap_add: NET_RAW` | Only capability needed (ICMP ping) |
| `no-new-privileges` | Prevent privilege escalation |
| `USER node` | Run as non-root |
| Health check | Auto-restart on failure (30s interval) |

### Common Operations

```bash
# View logs
docker compose logs -f

# Restart
docker compose restart

# Stop
docker compose down

# Update (rebuild)
docker compose up --build -d

# Reset database (destructive — removes all data)
docker compose down -v
```

### Reverse Proxy

For production with HTTPS, place behind a reverse proxy:

**Nginx example:**

```nginx
server {
    listen 443 ssl http2;
    server_name status.example.com;

    ssl_certificate /etc/ssl/certs/status.example.com.pem;
    ssl_certificate_key /etc/ssl/private/status.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The `Upgrade` and `Connection` headers are required for WebSocket (Socket.IO) to work.

## Manual Deployment (without Docker)

### Prerequisites

- Node.js 22+
- npm 10+
- `iputils-ping` or equivalent (for ICMP monitors)

### Steps

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Set environment
export NODE_ENV=production
export JWT_SECRET=$(openssl rand -base64 32)
export DB_PATH=/var/lib/uptime-detective/data.db

# Start
npm start
```

The server serves the Vue SPA from `client/dist/` in production mode — no separate frontend deployment needed.

### Systemd Service

```ini
[Unit]
Description=Uptime Detective
After=network.target

[Service]
Type=simple
User=uptime
WorkingDirectory=/opt/uptime-detective
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3300
Environment=DB_PATH=/var/lib/uptime-detective/data.db
EnvironmentFile=/opt/uptime-detective/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/uptime-detective
AmbientCapabilities=CAP_NET_RAW

[Install]
WantedBy=multi-user.target
```

## Backups

The database is a single SQLite file. Back it up with:

```bash
# While running (WAL mode makes this safe)
sqlite3 /path/to/uptime-detective.db ".backup '/path/to/backup.db'"

# Or with Docker volumes
docker compose exec uptime-detective sqlite3 /app/data/uptime-detective.db ".backup '/app/data/backup.db'"
docker cp uptime-detective:/app/data/backup.db ./backup.db
```

Schedule daily backups via cron for disaster recovery.
