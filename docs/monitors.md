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
| `group_id` | integer | `null` | Optional group assignment |
| `tags` | string[] | `[]` | Tags for filtering |
| `active` | boolean | `true` | Paused monitors don't run checks |

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
5. If no beat received: marked DOWN, notifications fire

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
| 0 | DOWN | Check failed after all retries |
| 2 | DEGRADED | Partially working (e.g., TLS cert expiring soon) |
| 3 | MAINTENANCE | Monitor is under a maintenance window |

## Pausing and Resuming

- `POST /api/v1/monitors/:id/pause` — Stops the scheduler job, sets `active = false`
- `POST /api/v1/monitors/:id/resume` — Restarts the scheduler job, sets `active = true`

Paused monitors retain their last known status but no new checks are performed.
