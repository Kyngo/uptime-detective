# Changelog

## v0.1.0 — Initial Build (2026-07-16)

Complete implementation of Uptime Detective across 4 development phases in a single session.

---

### Phase 1 — Foundation (MVP)

**Project Setup**
- Monorepo with npm workspaces: `server/`, `client/`, `shared/`
- TypeScript throughout (strict mode)
- Multi-stage Dockerfile (node:22-alpine) with health check
- docker-compose.yml with persistent volume and NET_RAW capability
- Vite dev server with API proxy to Express backend

**Database**
- SQLite with better-sqlite3 in WAL mode
- Versioned migration system (`_migrations` table)
- Full schema: users, monitors, checks, incidents, groups, status_pages, status_page_items, notifications, monitor_notifications, maintenance_windows, maintenance_monitors
- Performance indexes on check lookups and active monitors
- Seed script creates default admin user (bcrypt, 12 rounds)

**Authentication**
- JWT-based sessions (configurable expiry)
- API token auth (Bearer token, `ud_` prefix)
- Password change with current password verification
- Token generation/revocation from Settings

**HTTP Monitor**
- Full HTTP checker: configurable method, headers, body, timeout
- Response body regex matching (`body_match`)
- Accepted status code ranges (e.g. `200-299,301`)
- Redirect following (configurable)
- Retry logic with configurable retry count and interval

**Scheduler**
- node-cron based, one job per active monitor
- Interval-to-cron conversion (seconds → cron expression)
- Auto-starts all active monitors on server boot
- Graceful shutdown stops all jobs

**Real-time Updates**
- Socket.IO server with monitor subscription rooms
- Broadcasts check results to all connected dashboards
- Emits monitor lifecycle events (created, updated, deleted)
- Incident events (created, resolved)

**Frontend**
- Vue 3 SPA with Pinia state management
- Tailwind CSS with dark mode (class-based, system preference detection)
- Dashboard: monitor cards with live status dots and metrics
- Monitor Detail: Chart.js response time graph (5 timeframes), stats grid, checks table
- Monitor Form: create/edit with all HTTP-specific config fields
- Login page with error handling
- Settings page: API token management, password change
- App sidebar with navigation
- Composables: useApi (auth headers, 401 handling), useSocket (connection management), useTheme (dark/light toggle)

---

### Phase 2 — Monitor Types

**ICMP (Ping)**
- Spawns system `ping` command (cross-platform: Linux/macOS/Windows)
- Parses RTT from stdout with regex
- Handles DNS failure, packet loss, timeout errors
- Requires NET_RAW capability in Docker

**DNS**
- Uses Node.js `dns/promises` Resolver
- Supports: A, AAAA, CNAME, MX, TXT, NS, SOA, SRV record types
- Custom resolver server (defaults to 8.8.8.8 + 1.1.1.1)
- Expected value validation (optional)
- Timeout via Promise.race

**TLS/SSL**
- Raw TLS connection via `tls.connect()`
- Certificate expiry check with configurable warning threshold (default: 14 days)
- Returns DEGRADED status when cert expiring within warning window
- Reports issuer, chain validity, exact expiry date
- Handles: expired certs, not-yet-valid certs, connection failures

**TCP Port**
- Raw TCP socket connection via `net.Socket`
- Measures connection time
- Port from target string (`host:port`) or `config.port`
- Timeout with cleanup

**Heartbeat (Push)**
- Passive monitoring: external services push heartbeats to unique URL
- `GET/POST /api/v1/heartbeat/:token` (public, no auth)
- Scheduler checks if beat received within 2× interval
- Grace period for newly created monitors
- Auto-generates unique token on monitor creation
- Records heartbeat as successful check, resolves open incidents

---

### Phase 3 — Groups & Status Pages

**Groups API**
- Full CRUD with auto-generated slugs
- Monitor count enrichment on list
- Slug uniqueness with fallback suffix
- Monitors become ungrouped on group deletion (ON DELETE SET NULL)

**Status Pages API**
- Full CRUD with slug, description, logo URL, custom CSS
- Public/private toggle
- Item management: add groups or individual monitors to a page
- Bulk reorder items endpoint
- Auto-incrementing sort order

**Public Status Page**
- `GET /api/v1/status/:slug` — no auth required
- Returns: overall status, sections (groups with monitors), per-monitor data
- Per-monitor: current status, 90-day uptime percentage, daily uptime bars, recent incidents
- Overall status calculation: operational / degraded_performance / partial_outage / major_outage / maintenance

**Frontend**
- Groups view: list with monitor counts, create/edit modal, delete
- Status Pages view: list, create/edit, items builder modal (add/remove groups and monitors)
- Public Status Page view (`/status/:slug`): no sidebar, overall status banner, uptime bars, incident history
- UptimeBar component: 90-day colored bar visualization (green/yellow/orange/red by percentage)
- Group selector added to Monitor Form (create/edit)

---

### Phase 4 — Notifications & Maintenance

**Notification Channels**
- Webhook: POST/PUT JSON, optional HMAC-SHA256 signature, custom headers
- Email: nodemailer SMTP, HTML template with color-coded status
- Slack: incoming webhook with rich blocks and color attachment
- Discord: webhook with embeds (color, fields, timestamp, footer)
- Telegram: Bot API with MarkdownV2 formatting and escaped characters

**Notification Dispatcher**
- Routes to correct channel by type
- Fires on: DOWN, RECOVERY (UP), DEGRADED (TLS expiry)
- Maintenance window suppression (checks active windows before sending)
- Falls back to "default" channels when monitor has no linked channels
- Fire-and-forget (never blocks the checker)
- Per-channel error logging without breaking other channels

**Notifications API**
- Full CRUD for channels
- Test endpoint (`POST /notifications/:id/test`)
- Link/unlink channels to monitors (`POST/DELETE /monitors/:id/notifications/:nid`)
- List linked channels per monitor

**Maintenance Windows API**
- Full CRUD with start/end datetime and optional recurring schedule
- Link multiple monitors to a window
- Suppresses notifications during active windows

**Frontend**
- Notifications view: CRUD with dynamic config fields per type, test button, default toggle
- Maintenance view: schedule with datetime pickers, recurring select, multi-select monitor checkboxes
- Monitor Detail: notification channels section with link/unlink modal
- Sidebar: Notifications and Maintenance nav items added

---

### Code Audit & Fixes

After completing Phase 4, a complete codebase audit was performed. Issues found and fixed:

| Severity | Issue | Fix |
|----------|-------|-----|
| 🔴 Bug | Dev server and seed script created separate DBs (relative path CWD mismatch) | DB path now resolved from project root via `import.meta.url` |
| 🔴 Bug | Notifications only dispatched from HTTP checker (not ICMP/DNS/TLS/TCP/heartbeat) | Created `checker/shared.ts` — all checkers now use shared `handleStatusTransition` with notification dispatch |
| 🔴 Bug | `intervalToCron` wrong for 90s intervals (ran every 60s) | Fixed to use `Math.round` instead of `Math.floor` |
| 🔴 Bug | TLS timeout could resolve Promise twice | Added `resolved` flag guard |
| 🟡 Issue | Can't set retries to 0 (`0 || null` → null) | Changed to `!== undefined` check for all numeric fields |
| 🟡 Issue | No Socket.IO cleanup on route leave | Added `onUnmounted` with unsubscribe + `socket.off()` |
| 🟡 Issue | Duplicate Socket.IO emission (room + broadcast) | Removed per-room emit, single global broadcast via shared utility |
| 🟡 Issue | `shared` package missing `"type": "module"` | Added |
| 🟡 Issue | Heartbeat type not in form dropdown | Added option |
| 🟡 Issue | No body size limit on Express JSON parser | Added `{ limit: '1mb' }` |
| 🟡 Issue | 500+ lines of duplicated code across 5 checkers | Extracted into `checker/shared.ts` (each checker now ~50-75 lines) |
| 🟡 Issue | JSDoc comment containing `*/` broke esbuild parsing | Rewrote comment |

---

### What's Left (Phase 5 — Polish)

- [ ] Data retention service (auto-prune checks older than N days)
- [ ] Rate limiting on login and public endpoints
- [ ] SVG uptime badges (embeddable in READMEs)
- [ ] Import/export configuration
- [ ] Comprehensive test suite
- [ ] Performance optimization for large check tables
