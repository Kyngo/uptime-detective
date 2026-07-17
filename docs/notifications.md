# Notifications & Maintenance

## Notification Channels

Uptime Detective supports five notification channel types:

| Channel | Config Required |
|---------|----------------|
| **Webhook** | URL, optional HMAC-SHA256 secret, optional custom headers |
| **Email** | Recipient address (SMTP configured via env vars) |
| **Slack** | Incoming webhook URL |
| **Discord** | Webhook URL |
| **Telegram** | Bot token + chat ID |

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

```json
{
  "name": "Admin Bot",
  "type": "telegram",
  "config": {
    "bot_token": "123456:ABC-DEF...",
    "chat_id": "-1001234567890"
  }
}
```

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
