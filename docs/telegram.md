# Telegram Bot

Uptime Detective ships with a two-way Telegram bot. The bot is not only a notification channel: it is a full remote control for the instance.

- Check status, inspect monitors, restart checks.
- Create, edit, remove, pause and resume monitors.
- Mute and unmute alerts during maintenance or incidents.
- Manage the allow list of Telegram users that may control the instance.
- Send DOWN / RECOVERED / DEGRADED notifications through the same bot.
- Optionally run the whole dashboard as a **Telegram Mini App** (see [Mini App](#telegram-mini-app)).

## Single-Bot Model

One instance runs **one** Telegram bot, configured once with a single bot token. This is deliberate:

| Rule | Meaning |
|------|---------|
| One bot per instance | The token lives in instance settings (`telegram_bot_token`) or in `TELEGRAM_BOT_TOKEN`. There is no per-channel bot. |
| Only this bot controls the instance | All chat commands are handled by the instance-wide bot; saving a new token replaces the previous one. |
| Only this bot sends notifications | Existing `telegram` notification channels use the global token. A channel only stores the destination `chat_id`. |
| Long polling only | No webhook mode. The server calls `getUpdates`, which is simple to run behind a firewall or a reverse proxy. |

Commands and notifications share the token, but not the destination: notifications are sent to each channel's `chat_id`, while command replies go to the chat that sent the command.

## Setup

### 1. Create a bot with BotFather

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, choose a display name and a username that ends in `bot` (for example `acme_uptime_bot`).
3. BotFather returns a token like `123456789:AAH4k...`. Treat it as a password.

Optional BotFather steps:

| Command | When to use |
|---------|-------------|
| `/setcommands` | Register the command list shown in the Telegram UI. The bot also registers it automatically on start. |
| `/setdomain` | Only for the Mini App. Set the domain of your public HTTPS instance (for example `status.example.com`). |
| `/setdescription`, `/setabouttext`, `/setuserpic` | Cosmetic bot profile settings. |

### 2. Enable the bot

**Web UI (recommended):** open **Settings → Telegram Bot**, paste the token, enable the bot, and save. The server validates the token with `getMe` before saving it.

**Environment:**

```bash
TELEGRAM_BOT_TOKEN=123456789:AAH4k...
```

With `TELEGRAM_BOT_TOKEN` set, the token is managed by the environment: the web UI shows “Managed by environment” and the API refuses to overwrite or clear it. `TELEGRAM_BOT_ENABLED=false` (or `0`) disables chat control — the polling loop does not start and commands are not handled — but it does **not** remove the token, so notifications keep working. Without that flag an environment token enables the bot. A token saved from the web UI runs chat control only when the enabled switch is on.

The enable flag and notifications are independent: **notifications only need a configured bot token**, while the enabled switch controls whether the bot answers chat commands.

When the token is saved, the bot starts immediately if it is enabled. A bot restart re-registers the command list and, when a Mini App URL is configured, the chat menu button.

### 3. Authorize users

The bot is closed by default: an unknown Telegram user cannot run any command. See [Allow List](#allow-list).

## Allow List

Not all Telegram users are equal: every allowed Telegram user is effectively an **instance admin** (see [Security](#security)). Adding a user is therefore a deliberate admin action.

### Workflow

1. The new user sends `/start` (or any message) to the bot.
2. Because the user is unknown, the bot replies:

   ```text
   ⛔ Not authorized. Your Telegram user ID is 123456789. Ask an instance admin to allow you.
   ```

   The notice is sent at most once per 5 minutes per user. `/start` is always answered, so a user can always learn its own ID.

3. The user sends that numeric ID to the instance admin.
4. The admin adds the user in one of three ways:
   - **Web UI:** Settings → Telegram Bot → Allow list → add the numeric ID.
   - **Bot command:** an allowed user sends `/allow 123456789`.
   - **Environment bootstrap:** `TELEGRAM_ADMIN_USER_IDS=123456789,987654321` allows these users automatically every time the server starts.
5. The new user sends `/start` again. The bot confirms access and shows the command list.

The allow list keeps the metadata of every user that ever contacted the bot (username, first name, last name, last seen), including users that are not allowed. Users that are not allowed appear as “pending” in the web UI.

### `/allow` and `/deny`

- `/allow <id>` allows a numeric Telegram user ID. Replying `/allow` to a message from the user also works: the bot allows the sender of the message being replied to.
- `/deny <id>` removes a user from the allow list (reply with `/deny` to a message also works). The row is kept (the user is shown as not allowed and can be allowed again). A user cannot deny themselves; denying a user that never contacted the bot reports that.
- Allowed users are **not** notified by the bot about checks. Only notification channels configured in Uptime Detective receive alerts.

## Commands

All commands are available to allowed users only. Commands that take a monitor accept a **monitor reference** (see [Monitor References](#monitor-references)). The `/command@BotName` form also works.

### Reference Table

| Command | Syntax | Description |
|---------|--------|-------------|
| `/start` | `/start` | Welcome message with your Telegram user ID and allow-list status. Always answered, even for unknown users. |
| `/help` | `/help` | List of all bot commands. |
| `/status` | `/status` | Status overview: counts per status and a paginated monitor list (10 per page, ◀ Prev / Next ▶ buttons). Each line shows status emoji, `#id`, name, target, response time, 24h uptime, a paused marker and the remaining mute time. |
| `/info` | `/info <ref>` | Full monitor detail: type, target, group, tags, interval, timeout, retries, active state, current status, last check, 24h uptime, last incident, mute state. Heartbeat monitors show their heartbeat URL (`APP_URL` + path when `APP_URL` is set, otherwise the relative path). |
| `/add` | `/add` | Interactive wizard: type → target → name → group → interval → create. |
| `/add` (one-shot) | `/add <type> <target> [name] [group:<id\|name>]` | Create a monitor in one message. The name may be quoted; when omitted it is derived from the target. |
| `/edit` | `/edit <ref> [new target]` | Change a monitor's target. Without a target argument the bot asks for it. |
| `/remove` | `/remove <ref>` | Ask for confirmation with **🗑 Delete** / **Cancel** buttons, then delete. Confirmation expires after 2 minutes. |
| `/mute` | `/mute <ref\|all> [duration]` | Mute alert notifications for one monitor or for all monitors. Without a duration, the bot shows 15m / 1h / 4h / 12h / 1d buttons. |
| `/unmute` | `/unmute <ref\|all>` | Remove a monitor mute. `/unmute all` clears **all** active mutes (per-monitor and global) and reports how many were removed. |
| `/pause` | `/pause <ref>` | Pause a monitor: stops its scheduler job, sets `active = false`. |
| `/resume` | `/resume <ref>` | Resume a paused monitor: restarts its scheduler job, sets `active = true`. |
| `/restart` | `/restart [ref\|all]` | Force an immediate re-check. Runs the check now, then restarts the scheduler job. `/restart` and `/restart all` both mean all **active** monitors; target a paused monitor by ID or name to run one check on it (it stays paused). |
| `/ping` | `/ping <target>` | Run a one-off check against any target. Does **not** create a monitor and does **not** store results. |
| `/allow` | `/allow <id>` | Allow a Telegram user ID. Replying to a message with `/allow` allows that message's sender. |
| `/deny` | `/deny <id>` | Remove a user from the allow list. Refuses to deny yourself. |
| `/users` | `/users` | List allowed Telegram users (ID, @username, name, last seen) and the pending access requests. |
| `/groups` | `/groups` | List groups with ID, name and monitor count. |
| `/whoami` | `/whoami` | Show your own Telegram ID, username, name, chat ID/type and allow-list status. |
| `/app` | `/app` | Send a button that opens the dashboard as a Telegram Mini App. Only when a Mini App URL is configured. |
| `/cancel` | `/cancel` | Cancel a pending wizard or prompt (for example an `/add` wizard). |

### Examples

```text
/status
/info 12
/info #12
/info production api
```

```text
/add http https://api.example.com/health
/add http https://api.example.com/health "Production API" group:production
/add
```

```text
/edit 12 https://api.example.com/v2/health
/edit My Cool API https://new.example.com
/remove 12
/remove My Cool API
/mute 12 2h
/mute My Cool API 1h
/mute all 30m
/unmute 12
/unmute all
```

```text
/pause 4
/pause "Production API"
/resume 4
/restart
/restart 4
/ping https://example.com
/ping 1.1.1.1:443
/ping tls://example.com
/ping dns://example.com
```

```text
/allow 123456789
/deny 123456789
/users
/groups
/whoami
/app
```

### Interactive Flows

**`/add` wizard.** `/add` without arguments asks step by step: monitor type (inline buttons: HTTP, TCP, DNS, TLS, ICMP, Heartbeat), target, name (`-` derives the name from the target), group (inline buttons for up to 8 groups plus “No group”), interval (60s / 5m / 15m / 1h). The bot then creates the monitor and replies with a summary. Send `/cancel` to abort. The wizard expires after 2 minutes.

**`/edit`.** Without a new target the bot asks for one. Reply with the new target; `/cancel` aborts.

**`/remove`.** The bot replies with a summary and two inline buttons: **🗑 Delete** and **Cancel**. Nothing is deleted until **Delete** is pressed. The confirmation expires after 2 minutes and can only be used once.

**`/mute`.** Without a duration the bot shows inline duration buttons (15m / 1h / 4h / 12h / 1d). With a duration the mute is applied immediately and the reply shows the end time.

Only allowed users receive answers; pressing a button as a non-allowed user shows a “Not authorized” alert, and the allow list is re-checked on every message and callback.

### Monitor References

A monitor reference is one of:

| Form | Example | Meaning |
|------|---------|---------|
| Numeric ID | `12` | Monitor with ID 12 |
| Hash-prefixed ID | `#12` | Monitor with ID 12 |
| Quoted name | `"My Cool API"` | One token: the whole name, matched case-insensitively |
| Unquoted name | `My Cool API` | All remaining tokens joined with spaces |
| Keyword | `all` | All monitors (only for `/mute`, `/unmute`, `/restart`; for `/restart` it means all active monitors) |

Resolution order: numeric ID → case-insensitive exact name → unique substring match (so `production` finds “Production API”). Ambiguous names are rejected with up to 10 candidates; retry with an ID.

How each command reads its arguments:

| Command | Argument rule |
|---------|---------------|
| `/info`, `/remove`, `/pause`, `/resume`, `/unmute`, `/restart` | All tokens after the command are the reference (`/remove My Cool API` works). `/restart` and `/restart all` both mean all **active** monitors; target a paused monitor by ID or name to run a single check on it. `/unmute all` clears every mute. |
| `/edit <ref> [new target]` | One token → that token is the reference and the bot asks for the new target. Two or more tokens → the last token is the new target and the preceding tokens are the reference: `/edit My Cool API https://new.example.com`. Exception: if the last token is not a valid target for the matched monitor type, the whole input is treated as the reference and the bot asks for the target. |
| `/mute <ref\|all> [duration]` | Two or more tokens and the last parses as a duration → last token is the duration, preceding tokens are the reference (`/mute My Cool API 1h`). Otherwise all tokens are the reference and the bot shows the duration keyboard. A single token is always a reference (`/mute 12`, `/mute all`). `/mute 1 nonsense` replies “Invalid duration”. |

Quoting a name is optional but removes ambiguity — use it when the name ends with something that could be read as a duration or a new target.

### `/ping` Targets

`/ping` picks the check type from the target syntax:

| Target syntax | Check type |
|---------------|------------|
| `https://example.com` or `http://example.com` | HTTP |
| `tcp://host:port` or `host:port` | TCP |
| `tls://host` or `tls://host:port` | TLS certificate |
| `dns://example.com` | DNS |
| `icmp://host` or bare hostname/IP | ICMP ping |

`/ping` performs a single check and returns the result (status, response time, status code or message). It never writes to the checks table, never creates incidents and never sends notifications. It is rate-limited to one ping every 3 seconds per user.

For non-HTTP targets, `/ping` applies the same private-IP guard as HTTP monitors: loopback, private (10.x, 172.16-31.x, 192.168.x), link-local and cloud-metadata addresses are refused unless `ALLOW_PRIVATE_IPS=true` is set. HTTP targets are validated by the HTTP checker itself.

## Mute Semantics

Muting suppresses **notifications**; it does not stop checks.

| Action | Effect |
|--------|--------|
| `/mute 12 2h` | Monitor 12 alerts are suppressed for 2 hours. Checks continue and status/incidents are still recorded. |
| `/mute all 30m` | A global mute suppresses alerts for every monitor for 30 minutes. |
| `/unmute 12` | Removes the monitor-specific mute. |
| `/unmute all` | Removes all mutes (monitor-specific and global). |
| Mute expiry | A mute ends automatically at its `muted_until` time. Expired mutes are always filtered out on read and are pruned whenever mutes are created or removed. |
| Mute precedence | A mute for a specific monitor wins over a global mute. |
| Duration formats | `15m`, `30m`, `1h`, `4h`, `12h`, `1d`, `1w`; also `s`, `min`, `hour(s)`, `day(s)`, `week(s)` suffixes. A bare number is minutes (`90` = 90 minutes). The maximum is 30 days. |

Muting is independent of maintenance windows: maintenance suppresses notifications for planned downtime, mutes are ad-hoc silences. Both suppress notifications and neither pauses the check engine.

Use `/status` or `/info` to see the 🔇 mute marker and the remaining time.

## Remove Confirmation Flow

Deleting a monitor is irreversible. The bot always requires a second step:

1. `/remove 12` — the bot replies with a summary of the monitor and two inline buttons.
2. Press **🗑 Delete** to delete the monitor (checks, incidents and links cascade).
3. Press **Cancel**, send another command, or let the confirmation expire (2 minutes) to keep the monitor.

Each confirmation button can only be used once; pressing it twice reports that the confirmation expired.

## Notification Integration

Existing `telegram` notification channels keep working. Two changes:

- The channel stores **only** the destination: `chat_id` (and optionally `message_thread_id` for forum topics). The token is the global bot token from Settings → Telegram Bot or `TELEGRAM_BOT_TOKEN`.
- Notifications are sent whenever a bot token is configured, even if chat control is disabled (`TELEGRAM_BOT_ENABLED=false` or the enabled switch off). The enable flag only controls command handling and long polling.
- Notifications for muted monitors are suppressed (see [Mute Semantics](#mute-semantics)).

```json
{
  "name": "Admin Bot",
  "type": "telegram",
  "config": {
    "chat_id": "-1001234567890"
  }
}
```

Notifications are rendered with MarkdownV2 and an event-aware header: 🔴 DOWN, 🟢 RECOVERED, 🟡 DEGRADED, 🟡 TLS CERTIFICATE EXPIRING. When `APP_URL` is configured, each notification includes a link to the monitor page: `APP_URL/monitors/:id`.

Legacy configuration: channels that still contain a `bot_token` in their `config` keep working while the global token is absent (a deprecation warning is logged), and the database migration copies the first legacy token into the instance settings and removes it from the channel. Re-save old channels from the web UI so only `chat_id` remains.

To send a test message: **Settings → Telegram Bot → Test message** (with a `chat_id`), or:

```bash
curl -X POST http://localhost:3300/api/v1/telegram/test \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "-1001234567890"}'
```

Without a `chat_id`, the test message goes to the first allowed Telegram user that has contacted the bot.

## Telegram Mini App

### Can this app be included as a Telegram web app?

**Yes.** Telegram allows bots to open web applications (Telegram Mini Apps, formerly Web Apps) inside the Telegram client. Uptime Detective implements the server side: a menu button opens your dashboard inside Telegram and the SPA auto-logs-in by validating the Telegram `initData` signature.

This is not a special build: the normal Vue SPA is served from the same instance. Telegram only provides the container (WebView) and the signed `initData` payload.

### Requirements

| Requirement | Details |
|-------------|---------|
| Public HTTPS URL | The URL must be reachable from the Telegram clients that open it. A localhost URL or a private-only address does not work. |
| Valid TLS certificate | HTTPS with a valid certificate chain. Self-signed certificates are rejected by Telegram. See [Deployment](./deployment.md). |
| BotFather domain | Run `/setdomain` in BotFather for your bot and set the instance domain (for example `status.example.com`). |
| Menu button registration | Uptime Detective registers the bot menu button automatically when a Mini App URL is configured and the bot restarts. |
| Bot token configured | The Mini App login validates `initData` with the bot token, so a token must be saved (environment or Settings → Telegram Bot). The menu button is registered when the bot starts, so enable the bot to get it. |
| Allow list | The Telegram user opening the Mini App must be on the allow list. Otherwise the login is refused (403). |

### Enable the Mini App

1. Configure a public HTTPS URL for your instance (see [Deployment](./deployment.md)).
2. Set the Mini App URL in one of two ways:
   - **Web UI:** Settings → Telegram Bot → **Mini App web app URL**, for example `https://status.example.com`.
   - **Environment:** `TELEGRAM_WEBAPP_URL=https://status.example.com` (the environment variable wins over the setting).
3. Optionally set the domain in BotFather with `/setdomain`.
4. Save/restart the bot. The server registers a `web_app` menu button pointing at the URL.

When a `telegram_webapp_url`/`TELEGRAM_WEBAPP_URL` is **not** configured, `/app` replies that the Mini App is not configured.

### How it works

1. The user opens the bot chat and taps the menu button (or the `/app` button).
2. Telegram opens the URL in its WebView and appends `tgWebAppData` to the page URL (in the hash or the query string).
3. The SPA detects `tgWebAppData`, strips it from the URL, and POSTs the raw `init_data` to `POST /api/v1/telegram/webapp/auth`.
4. The server validates the `initData` HMAC signature with the bot token, checks `auth_date` freshness, and enforces the allow list.
5. On success the server creates or reuses a shadow local user for the Telegram account (`tg_<id>`, role `admin`, random unusable password) and returns a normal JWT. The SPA stores the JWT and the dashboard loads logged in.
6. On failure the SPA continues to the normal login page; the reason is shown in the browser console.

The auth endpoint is public (it authenticates by signature, not by JWT), rate-limited to 20 requests per minute per IP, and never returns the bot token. Responses: `400` missing or malformed `init_data` (missing `init_data`, malformed query string, missing `hash`/`auth_date`/`user`, invalid user payload or ID), `401` invalid signature or expired/future `auth_date`, `403` Telegram user not allowed, `503` bot not configured. The rest of the API stays protected by the normal authentication.

### Limitations

- **Telegram WebView** — the dashboard runs inside the Telegram in-app browser (iOS, Android, desktop). The UI is mobile-first; complex pages are tighter than in a full browser.
- **Public reachability** — Telegram clients must be able to reach your instance URL over the public internet. Self-hosted instances on LAN-only hosts cannot use the Mini App.
- **JWT lifetime** — the Mini App exchanges `initData` for a regular JWT, valid for `SESSION_EXPIRY` (default 7d). The `initData` payload itself is accepted for at most `TELEGRAM_WEBAPP_AUTH_MAX_AGE` seconds (default 24h), counted from `auth_date`.
- **No Bot API access from the browser** — the SPA never receives the bot token and cannot call the Telegram Bot API itself. All Telegram-specific operations go through the Uptime Detective server.
- **Allow list is authoritative** — removing a user from the allow list blocks future Mini App logins for that Telegram account (existing JWT sessions follow the normal session rules).
- **BotFather domain binding** — if the bot's domain is set in BotFather, the Mini App URL must be on that domain.

## Environment Variables

All variables are optional unless noted; the bot can also be fully configured from the web UI.

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token. Overrides the token saved in the database and cannot be changed from the API while set. When set, the bot runs enabled unless explicitly disabled. |
| `TELEGRAM_BOT_ENABLED` | `true` | Set to `false` (or `0`) to disable chat control: the polling loop does not start and commands are not handled. Notifications continue to work as long as a bot token is configured. A token saved from the web UI runs chat control only when the enabled switch is on. |
| `TELEGRAM_ADMIN_USER_IDS` | — | Comma-separated Telegram user IDs allowed automatically when the server starts, before any web UI action (bootstrap allow list). |
| `TELEGRAM_API_BASE_URL` | `https://api.telegram.org` | Telegram Bot API base URL. Useful for tests and for self-hosted Bot API servers/reverse proxies. |
| `TELEGRAM_WEBAPP_URL` | — | Public HTTPS URL of the instance for the Mini App. Wins over the `telegram_webapp_url` setting. Must use `https://` (validated, because Telegram requires it). |
| `TELEGRAM_WEBAPP_AUTH_MAX_AGE` | `86400` | Maximum accepted age of Mini App `initData` in seconds (24 hours). |
| `APP_URL` | — | Public base URL of the instance, used for monitor links in Telegram notifications and to make the heartbeat URL absolute in `/info` (without it, `/info` shows the relative `/api/v1/heartbeat/...` path). |

See [Configuration](./configuration.md) for the full environment variable reference.

## Security

- **Allowed Telegram users are instance admins.** They can create, delete and restart monitors and change the bot settings. Allow users the same way you would grant dashboard admin access.
- **Token secrecy.** The bot token is a password. It is never logged and never returned by the API (only a truncated hint such as `12345678…:…wxyz` is shown). Anyone with the token can control the bot.
- **Allow list first.** Unknown users can only read their own numeric ID; all commands, buttons and Mini App logins are refused until an admin allows them.
- **Environment-managed token.** A token set via `TELEGRAM_BOT_TOKEN` cannot be overwritten or cleared through the API, which prevents a compromised admin session from replacing the bot.
- **Rate limits.** The Mini App auth endpoint is rate-limited per IP; `/ping` is rate-limited per user (one per 3 seconds). The polling loop backs off on Telegram errors.
- **Input safety.** All user text echoed in bot messages is HTML-escaped; monitor references are resolved against the database only.
- **No webhook.** Long polling means no inbound endpoint is exposed for Telegram; only the outbound Bot API calls are required.

## Troubleshooting

### The bot is not running / `last_error` shows 409

`409 Conflict` from `getUpdates` means another process is polling the same bot token (or a webhook is registered). Only one poller per token is allowed.

- Stop the other process using this bot token (another instance, a bot script, a test harness).
- Make sure the token is not used by two Uptime Detective instances.
- The server deletes the stale webhook automatically when it detects this conflict and retries.

### Invalid token / `401 Unauthorized` from Telegram

- The token is wrong, revoked or has a typo. Copy it again from BotFather with `/mybots` → your bot → *API Token*.
- The web UI validates the token with `getMe` before saving; a save error means Telegram rejected the token.
- If `TELEGRAM_BOT_TOKEN` is set, change the value in `.env` and restart the server (the UI cannot edit it).

### "Not authorized" for a user who should have access

1. The user sends `/start` to the bot; the reply includes their numeric Telegram ID.
2. Add that ID in Settings → Telegram Bot → Allow list, or use `/allow <id>` from an allowed account.
3. Check `/users` in the bot (or the web UI) to confirm `is_allowed` is on.
4. For a Mini App login, the same allow-list rule applies to the Telegram account that opens it.

### Polling is blocked behind a proxy/firewall

The server must be able to reach the Bot API (`https://api.telegram.org`, or your `TELEGRAM_API_BASE_URL`). If the network requires an HTTP(S) proxy, configure it at the Node.js level. Symptoms: repeated connection errors in the server log and `last_error` in Settings → Telegram Bot.

### Mini App shows "hash invalid" / sign-in rejected

Telegram's client may show a hash error, and the Uptime Detective API answers `401 Invalid Telegram init data signature`. Common causes:

- The Mini App URL domain differs from the domain configured in BotFather (`/setdomain`); Telegram signs the data for the bound domain.
- The Mini App was opened from a stale/edited link, or the URL was copied and reopened outside Telegram.
- The bot token changed after the page was opened; reload the Mini App.
- The page was served over plain HTTP, or behind a proxy that rewrites the query string.

### Mini App shows "auth_date expired"

The `initData` payload is older than `TELEGRAM_WEBAPP_AUTH_MAX_AGE` (default 86400 seconds). Reopen the Mini App from the bot menu button. If the server clock is wrong, Telegram timestamps are rejected early — check the server clock.

### Mini App login returns 503

The Mini App auth endpoint needs a configured bot token (environment or Settings → Telegram Bot). Save a token, then reopen the Mini App.

### Notifications are not delivered

- A bot token must be configured (environment or Settings → Telegram Bot); otherwise the notifier fails with “Telegram bot is not configured”. The control bot does not need to be enabled for notifications.
- Each `telegram` notification channel needs a valid `chat_id`; the bot must be a member of the target group/channel.
- Check that the monitor is not muted (`/mute` state is shown in `/status`) and not inside a maintenance window.
- Existing channels saved before this version may still contain a `bot_token`; re-save them so only `chat_id` remains.
