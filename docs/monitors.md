# Monitors

## Monitor Types

| Type | Description | Key Metrics |
|------|-------------|-------------|
| **HTTP(S)** | Configurable method, headers, body, status code validation, body regex | Response time, status code |
| **ICMP Ping** | System ping command (cross-platform: Linux/macOS/Windows) | RTT, packet loss |
| **DNS** | Query records (A, AAAA, CNAME, MX, TXT, NS, SOA, SRV) | Resolution time |
| **TLS/SSL** | Certificate expiry and chain validation | Days until expiry, issuer |
| **TCP Port** | Raw TCP socket connection check | Connection time |
| **Heartbeat** | Passive — external services push to a unique URL | Time since last beat |

## Monitor Configuration

Every monitor has these common fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Human-readable label |
| `type` | enum | required | `http`, `icmp`, `dns`, `tls`, `tcp`, `heartbeat` |
| `target` | string | required | URL, hostname, or IP (depends on type) |
| `interval` | integer | `60` | Check frequency in seconds (min: 20s) |
| `timeout` | integer | `10000` | Max wait time in ms |
| `retries` | integer | `1` | Retry count before marking DOWN |
| `retry_interval` | integer | `30` | Seconds between retries |
| `failure_threshold` | integer | `1` | Consecutive failed checks before the monitor is reported DOWN (1–100) |
| `recovery_threshold` | integer | `1` | Consecutive successful checks before a DOWN monitor is reported UP (1–100) |
| `group_id` | integer | `null` | Optional group assignment |
| `tags` | string[] | `[]` | Tags for filtering |
| `active` | boolean | `true` | Paused monitors don't run checks |

## Failure and Recovery Thresholds

By default a monitor flips to DOWN on the first failed check (after the
in-check `retries` are exhausted) and back to UP on the first successful check.
That makes a single transient error enough to open an incident — and a single
successful check enough to close it again.

`failure_threshold` and `recovery_threshold` add confirmation to both
directions, per monitor:

- Every check is still recorded in `checks` and stays visible in the history.
- The **reported status** only changes after the configured number of
  **consecutive** checks:
  - `failure_threshold` consecutive failed checks → DOWN (incident + alert).
  - `recovery_threshold` consecutive successful checks → UP (incident resolved +
    recovery alert).
- A check of the opposite result resets the current streak.
- While a streak is still below its threshold the monitor keeps its previous
  reported status, so a single blip never creates an incident or a recovery
  notification.
- DEGRADED (TLS expiry warning) still applies immediately; it is not queued.

The distinction from `retries` matters: `retries` are extra attempts **inside a
single scheduled check**, while the thresholds count **consecutive scheduled
checks** (or heartbeat beats). Use both when you want retries for flaky
connections and confirmation across check cycles.

**Example** — `interval: 60`, `failure_threshold: 3`, `recovery_threshold: 2`:

| Check | Result | Reported status | Incident / notification |
|-------|--------|-----------------|-------------------------|
| 1 | fail | UP (unchanged) | none |
| 2 | fail | UP (unchanged) | none |
| 3 | fail | **DOWN** | incident opened, DOWN alert |
| 4 | success | DOWN (unchanged) | none |
| 5 | success | **UP** | incident resolved, recovery alert |

Thresholds can be edited at any time from **Monitors → Edit monitor** or via
`PUT /api/v1/monitors/:id`. The new values take effect on the next check.

## HTTP Monitors

Additional config (stored in `config` JSON field):

| Field | Default | Description |
|-------|---------|-------------|
| `method` | `GET` | HTTP method (GET, POST, HEAD, PUT, DELETE) |
| `accepted_status_codes` | `200-299` | Status code range(s) to consider UP |
| `headers` | `{}` | Custom request headers (JSON object) |
| `body` | `null` | Request body for POST/PUT |
| `body_match` | `null` | Regex to validate response body |

The checker follows redirects and validates the final response against the configured criteria.

## ICMP (Ping) Monitors

- Spawns system `ping` command (cross-platform argument handling)
- Parses RTT from stdout with regex
- Requires `NET_RAW` capability in Docker
- Reports: RTT in ms, or error message on failure

Target: hostname or IP address.

## DNS Monitors

Additional config:

| Field | Default | Description |
|-------|---------|-------------|
| `dns_record_type` | `A` | Record type: A, AAAA, CNAME, MX, TXT, NS, SOA, SRV |
| `dns_resolver` | `8.8.8.8, 1.1.1.1` | Custom DNS server(s) |
| `expected_value` | `null` | Optional: validate resolved value matches |

Uses Node.js `dns/promises` Resolver with timeout via `Promise.race`.

## TLS/SSL Monitors

Additional config:

| Field | Default | Description |
|-------|---------|-------------|
| `tls_expiry_warning_days` | `14` | Days before expiry to trigger DEGRADED status |

Connects via `tls.connect()` and reports:
- Certificate issuer and subject
- Exact expiry date
- Chain validity
- Status: UP (valid), DEGRADED (expiring soon), DOWN (expired/invalid)

Target: hostname (port 443 by default).

## TCP Port Monitors

Target format: `hostname:port` or just hostname with port in config.

Connects via raw `net.Socket` and measures connection time. Reports UP if connection succeeds within timeout, DOWN otherwise.

## Heartbeat (Push) Monitors

Unlike other types, heartbeat monitors are **passive**. Instead of the system checking an endpoint, your external service pushes a signal to Uptime Detective.

### How It Works

1. Create a heartbeat monitor in the dashboard
2. A unique token is auto-generated (visible in monitor detail)
3. Your service pings the heartbeat URL periodically
4. The scheduler checks if a beat was received within 2× the configured interval
5. If no beat received: marked DOWN after `failure_threshold` consecutive missed checks, notifications fire

### Usage

```bash
# Simple GET (works from cron, scripts, etc.)
curl -s https://your-instance/api/v1/heartbeat/YOUR_TOKEN

# POST also works
curl -X POST https://your-instance/api/v1/heartbeat/YOUR_TOKEN
```

No authentication required — the token itself is the auth.

### Use Cases

- Cron jobs: ping after successful completion
- Background workers: ping on each cycle
- Batch jobs: ping after processing
- Backup scripts: ping when backup finishes

### Grace Period

Newly created heartbeat monitors have a grace period — they won't be marked DOWN until at least 2× their interval has passed without a beat. This prevents false alerts on creation.

## Status Values

| Code | Status | Meaning |
|------|--------|---------|
| 1 | UP | Check passed successfully |
| 0 | DOWN | `failure_threshold` consecutive checks failed (after in-check retries) |
| 2 | DEGRADED | Partially working (e.g., TLS cert expiring soon) |
| 3 | MAINTENANCE | Monitor is under a maintenance window |

## Pausing and Resuming

- `POST /api/v1/monitors/:id/pause` — Stops the scheduler job, sets `active = false`
- `POST /api/v1/monitors/:id/resume` — Restarts the scheduler job, sets `active = true`

Paused monitors retain their last known status but no new checks are performed.

The Telegram bot exposes the same operations: `/pause <ref>` and `/resume <ref>` (see [Telegram Bot](./telegram.md#commands)). Muting alert notifications (`/mute`) is a separate action: checks keep running while a monitor is muted.
