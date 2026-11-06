# Notifications & Maintenance

## Notification Channels

Uptime Detective supports five notification channel types:

| Channel | Config Required |
|---------|----------------|
| **Webhook** | URL, optional HMAC-SHA256 secret, optional custom headers |
| **Email** | Recipient address (SMTP configured via env vars) |
| **Slack** | Incoming webhook URL |
| **Discord** | Webhook URL |
| **Telegram** | Chat ID (the bot token is configured once instance-wide) |

## Channel Setup

### Webhook

Sends a POST request with JSON payload to your URL.

```json
{
  "name": "PagerDuty Integration",
  "type": "webhook",
  "config": {
    "url": "https://events.pagerduty.com/integration/...",
    "method": "POST",
    "secret": "optional-hmac-sha256-key",
    "headers": { "X-Custom": "value" }
  }
}
```

If `secret` is provided, a `X-Signature` header is added with the HMAC-SHA256 of the request body.

### Email

Requires SMTP configuration in `.env` (see [Configuration](./configuration.md)).

```json
{
  "name": "Ops Team",
  "type": "email",
  "config": {
    "to": "ops@example.com"
  }
}
```

Sends HTML-formatted emails with color-coded status indicators.

### Slack

Uses Slack's incoming webhook format with rich block messages.

```json
{
  "name": "Alerts Channel",
  "type": "slack",
  "config": {
    "webhook_url": "https://hooks.slack.com/services/T.../B.../..."
  }
}
```

### Discord

Uses Discord webhook with rich embeds (color, fields, timestamp, footer).

```json
{
  "name": "Server Alerts",
  "type": "discord",
  "config": {
    "webhook_url": "https://discord.com/api/webhooks/123/abc..."
  }
}
```

### Telegram

Uses Telegram Bot API with MarkdownV2 formatting.

Uptime Detective runs **one global Telegram bot** per instance. Configure its token once in **Settings → Telegram Bot** (or with `TELEGRAM_BOT_TOKEN`); notification channels only need the destination chat ID.

```json
{
  "name": "Admin Bot",
  "type": "telegram",
  "config": {
    "chat_id": "-1001234567890"
  }
}
```

- `chat_id` — Telegram chat, group or channel ID the bot posts to. The bot must be a member of that chat.
- `message_thread_id` — optional; target a specific topic in a forum group.
- The global bot token is used for every `telegram` channel; it is never stored in the channel config.
- A bot token must be configured (environment or Settings → Telegram Bot); otherwise sending fails with “Telegram bot is not configured”. The enable flag (`telegram_bot_enabled` / `TELEGRAM_BOT_ENABLED`) only controls chat control (long polling and commands), not notifications: with a token present, alerts are still delivered even when the bot is disabled for commands.
- When `APP_URL` is set, each notification includes a link to `APP_URL/monitors/:id`.
- **Mutes suppress notifications.** A monitor muted with `/mute` (or a global mute) does not send notifications while the mute is active, even though checks keep running.

Legacy configuration: an old channel config that still contains a `bot_token` keeps working only while no global token is configured, and logs a deprecation warning. The database migration copies the first legacy token into the instance settings. Re-save old channels so only `chat_id` remains, and see [Telegram Bot](./telegram.md) for the full bot setup.

## When Notifications Fire

| Event | Description |
|-------|-------------|
| Monitor DOWN | Check failed after all retries — service is unreachable |
| Monitor RECOVERY | Previously down monitor is back UP |
| TLS DEGRADED | Certificate expiring within warning threshold |
| Heartbeat MISSED | No heartbeat received within 2× interval |

## Linking Channels to Monitors

Each monitor can have specific notification channels linked:

```bash
# Link a channel to a monitor
POST /api/v1/monitors/1/notifications/3

# Unlink
DELETE /api/v1/monitors/1/notifications/3

# List linked channels for a monitor
GET /api/v1/monitors/1/notifications
```

### Default Channels

Channels marked as `is_default: true` fire for monitors that have **no explicitly linked channels**. This provides a safety net — new monitors get notifications without manual linking.

## Notification Behavior

- Notifications are **fire-and-forget** — a failed notification never blocks or crashes the check engine
- Each channel is dispatched independently — one channel failing doesn't prevent others
- Errors are logged but don't affect pipeline execution
- Test notifications can be sent via `POST /api/v1/notifications/:id/test`
- Notifications are suppressed while a monitor is muted (`/mute` in the bot, per monitor or globally) — checks still run
- Notifications are suppressed during maintenance windows (see below)
- The single global Telegram bot token sends both notifications and bot-control replies; see [Telegram Bot](./telegram.md)

---

## Maintenance Windows

Maintenance windows let you schedule planned downtime and suppress notifications for affected monitors.

### Creating a Window

```json
{
  "title": "Database Migration",
  "description": "Upgrading to PostgreSQL 16",
  "start_at": "2026-07-20T02:00:00Z",
  "end_at": "2026-07-20T04:00:00Z",
  "recurring": null,
  "monitor_ids": [1, 3, 5]
}
```

### Recurring Schedules

| Value | Behavior |
|-------|----------|
| `null` | One-time window |
| `"daily"` | Repeats every day at the same time |
| `"weekly"` | Repeats every week on the same day |
| `"monthly"` | Repeats every month on the same date |

### During Active Maintenance

- Notifications are **suppressed** for affected monitors
- Monitor status shows as `MAINTENANCE` (status code 3)
- Public status pages display a maintenance banner
- Checks still run (so you can see when the service comes back)
- Once the window ends, normal notification behavior resumes

### API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/maintenance` | List all windows |
| POST | `/api/v1/maintenance` | Create window |
| PUT | `/api/v1/maintenance/:id` | Update window |
| DELETE | `/api/v1/maintenance/:id` | Delete window |
