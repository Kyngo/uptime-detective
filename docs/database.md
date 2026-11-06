# Database

## Overview

Uptime Detective uses **SQLite** via `better-sqlite3` with WAL (Write-Ahead Logging) mode for concurrent read performance.

The database file is stored at the path configured by `DB_PATH` (default: `./data/uptime-detective.db`). The directory is created automatically if it doesn't exist.

## Pragmas

```sql
PRAGMA journal_mode = WAL;    -- Better concurrent reads
PRAGMA foreign_keys = ON;     -- Enforce referential integrity
PRAGMA busy_timeout = 5000;   -- Wait 5s on lock instead of failing immediately
```

## Schema

### users

Multi-user support with role-based access.

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin' CHECK(role IN ('admin', 'viewer')),
  api_token TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### monitors

Core monitor definitions with type-specific config stored as JSON.

```sql
CREATE TABLE monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('http', 'icmp', 'dns', 'tls', 'tcp', 'heartbeat')),
  target TEXT NOT NULL,
  interval INTEGER DEFAULT 60,
  timeout INTEGER DEFAULT 10000,
  retries INTEGER DEFAULT 1,
  retry_interval INTEGER DEFAULT 30,
  config JSON DEFAULT '{}',
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  tags JSON DEFAULT '[]',
  active INTEGER DEFAULT 1,
  heartbeat_token TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### checks

Append-only log of every check result. This is the largest table by far.

```sql
CREATE TABLE checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  status INTEGER NOT NULL CHECK(status IN (0, 1, 2, 3)),
  response_time INTEGER,
  status_code INTEGER,
  message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Status codes: `0` = DOWN, `1` = UP, `2` = DEGRADED, `3` = MAINTENANCE.

### incidents

Aggregated downtime events — created when a monitor goes DOWN, resolved when it recovers.

```sql
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at DATETIME NOT NULL,
  resolved_at DATETIME,
  duration_seconds INTEGER,
  cause TEXT
);
```

### groups

Monitor groups for organization and status page composition.

```sql
CREATE TABLE groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### status_pages

Public (or private) status page definitions.

```sql
CREATE TABLE status_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  logo_url TEXT,
  custom_css TEXT,
  is_public INTEGER DEFAULT 1,
  show_powered_by INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### status_page_items

Maps groups or individual monitors to a status page.

```sql
CREATE TABLE status_page_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_page_id INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  CHECK ((group_id IS NOT NULL AND monitor_id IS NULL) OR (group_id IS NULL AND monitor_id IS NOT NULL))
);
```

### notifications

Notification channel definitions with type-specific config.

```sql
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('webhook', 'email', 'slack', 'discord', 'telegram')),
  config JSON NOT NULL DEFAULT '{}',
  is_default INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### monitor_notifications

Many-to-many link between monitors and notification channels.

```sql
CREATE TABLE monitor_notifications (
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  PRIMARY KEY (monitor_id, notification_id)
);
```

### maintenance_windows

Scheduled maintenance periods.

```sql
CREATE TABLE maintenance_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  start_at DATETIME NOT NULL,
  end_at DATETIME NOT NULL,
  recurring TEXT CHECK(recurring IN ('daily', 'weekly', 'monthly') OR recurring IS NULL),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### maintenance_monitors

Links maintenance windows to affected monitors.

```sql
CREATE TABLE maintenance_monitors (
  maintenance_id INTEGER NOT NULL REFERENCES maintenance_windows(id) ON DELETE CASCADE,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  PRIMARY KEY (maintenance_id, monitor_id)
);
```

### settings

Key-value store for application settings.

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### telegram_users

Telegram users known to the bot (allowed and pending). Every user that contacts the bot is tracked here; only rows with `is_allowed = 1` may run commands.

```sql
CREATE TABLE telegram_users (
  telegram_user_id INTEGER PRIMARY KEY,
  chat_id INTEGER,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  is_allowed INTEGER NOT NULL DEFAULT 0,
  allowed_by INTEGER,
  last_seen_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### monitor_mutes

Active and expired alert mutes, per monitor or global. A row with `monitor_id IS NULL` is a global mute. Expired mutes are always filtered out on read and are pruned when mutes are created or removed.

```sql
CREATE TABLE monitor_mutes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
  muted_until DATETIME NOT NULL,
  muted_by TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Muting suppresses notifications only; checks keep running. Deleting a monitor cascades its mutes.

The bot settings themselves live in the `settings` table (token, username, enabled flag, Mini App URL), not in a dedicated table.

## Indexes

```sql
CREATE INDEX idx_checks_monitor_created ON checks(monitor_id, created_at DESC);
CREATE INDEX idx_checks_created ON checks(created_at);
CREATE INDEX idx_incidents_monitor ON incidents(monitor_id);
CREATE INDEX idx_incidents_open ON incidents(monitor_id, resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX idx_monitors_group ON monitors(group_id);
CREATE INDEX idx_monitors_active ON monitors(active) WHERE active = 1;
CREATE INDEX idx_telegram_users_allowed ON telegram_users(is_allowed);
CREATE INDEX idx_monitor_mutes_monitor ON monitor_mutes(monitor_id);
CREATE INDEX idx_monitor_mutes_until ON monitor_mutes(muted_until);
```

The most critical index is `idx_checks_monitor_created` — it supports the primary query pattern of "get recent checks for a specific monitor."

## Migrations

Migrations are versioned and tracked in a `_migrations` table:

```sql
CREATE TABLE _migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- Migrations run automatically on server startup
- Each migration runs in a transaction (atomic)
- Already-applied migrations are skipped
- New migrations are added to the `MIGRATIONS` array in `server/src/db/migrate.ts`

### Migration v3 — Telegram bot and mutes

Version 3 adds:

- The `telegram_users` and `monitor_mutes` tables (with indexes)
- A legacy token import: if no `telegram_bot_token` setting exists yet, the first `telegram` notification channel whose config contains `bot_token` donates that token to the instance settings (`telegram_bot_token`, and `telegram_bot_enabled = '1'` if that setting does not exist yet). The token is then removed from the channel config, which keeps its `chat_id`. Malformed channel JSON is skipped instead of failing the migration.

After upgrading, old channels still contain a `chat_id` and keep working with the global token. No manual step is required.

To run manually: `npm run db:migrate`

## Data Retention

The `checks` table grows continuously. At 60-second intervals:
- 100 monitors ≈ 144,000 rows/day ≈ ~100MB for 90 days

A data retention service (planned) will auto-prune checks older than a configurable threshold.

## Backups

SQLite with WAL mode allows safe backups while the server is running:

```bash
sqlite3 /path/to/uptime-detective.db ".backup '/path/to/backup.db'"
```

## Size Estimates

| Monitors | Interval | 90 Days | Rows |
|----------|----------|---------|------|
| 10 | 60s | ~10 MB | 1.3M |
| 50 | 60s | ~50 MB | 6.5M |
| 100 | 60s | ~100 MB | 13M |
| 500 | 60s | ~500 MB | 65M |
