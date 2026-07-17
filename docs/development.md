# Development

## Prerequisites

- Node.js 22+
- npm 10+

## Getting Started

```bash
# Clone and install
git clone <repo-url> uptime-detective
cd uptime-detective
npm install

# Create .env from example
cp .env.example .env

# Start both server and client in dev mode
npm run dev
```

On first launch, the app redirects to the **Setup Wizard** at `/setup` to create your admin account.

- Frontend: http://localhost:5173 (Vite dev server with HMR)
- Backend: http://localhost:3300 (Express with tsx watch)

The Vite dev server proxies `/api/*` and `/socket.io/*` to the backend automatically.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start server + client concurrently |
| `npm run dev:server` | Server only (tsx watch, auto-reload) |
| `npm run dev:client` | Client only (Vite HMR) |
| `npm run build` | Build shared + client + server for production |
| `npm start` | Start production server (requires build first) |
| `npm run db:migrate` | Run database migrations manually |
| `npm run db:seed` | Create a default admin user with random password |

## Seeding

The seed script creates a default admin user with a randomly generated password:

```bash
npm run db:seed
```

The password is printed to the console once — save it immediately. For normal development, use the setup wizard instead.

## Project Structure

```
uptime-detective/
├── server/                     # Express.js backend
│   └── src/
│       ├── index.ts            # Entry point, server bootstrap
│       ├── app.ts              # Express app setup, middleware, static serving
│       ├── socket.ts           # Socket.IO setup and event broadcasting
│       ├── db/
│       │   ├── connection.ts   # SQLite connection (WAL mode)
│       │   ├── migrate.ts      # Versioned migration system
│       │   └── seed.ts         # Default admin user creation
│       ├── middleware/
│       │   └── auth.ts         # JWT + API token authentication
│       ├── routes/
│       │   ├── auth.ts         # Login, token management
│       │   ├── monitors.ts     # Monitor CRUD + pause/resume
│       │   ├── groups.ts       # Group management
│       │   ├── heartbeat.ts    # Heartbeat push endpoint
│       │   ├── notifications.ts# Channel CRUD + linking
│       │   ├── maintenance.ts  # Maintenance window management
│       │   ├── status-pages.ts # Status page builder
│       │   ├── public-status.ts# Public status page data
│       │   └── setup.ts        # First-run setup wizard
│       └── services/
│           ├── scheduler.ts    # node-cron job management
│           ├── checker/        # Monitor type implementations
│           │   ├── shared.ts   # Common check logic (status transitions, notifications)
│           │   ├── http.ts
│           │   ├── icmp.ts
│           │   ├── dns.ts
│           │   ├── tls.ts
│           │   ├── tcp.ts
│           │   └── heartbeat.ts
│           └── notifiers/      # Notification dispatchers
│               ├── dispatcher.ts
│               ├── webhook.ts
│               ├── email.ts
│               ├── slack.ts
│               ├── discord.ts
│               └── telegram.ts
├── client/                     # Vue 3 frontend
│   └── src/
│       ├── App.vue             # Root layout (sidebar + router-view)
│       ├── main.ts             # Vue app bootstrap
│       ├── router/index.ts     # Route definitions + auth/setup guards
│       ├── stores/auth.ts      # Pinia auth store
│       ├── composables/
│       │   ├── useApi.ts       # HTTP client with auth headers + 401 handling
│       │   ├── useSocket.ts    # Socket.IO connection management
│       │   └── useTheme.ts     # Dark/light mode toggle
│       ├── components/
│       │   ├── AppSidebar.vue  # Navigation sidebar (responsive)
│       │   └── UptimeBar.vue   # 90-day uptime visualization
│       └── views/              # Page components
│           ├── Dashboard.vue
│           ├── MonitorDetail.vue
│           ├── MonitorForm.vue
│           ├── Groups.vue
│           ├── StatusPages.vue
│           ├── PublicStatusPage.vue
│           ├── Notifications.vue
│           ├── Maintenance.vue
│           ├── Settings.vue
│           ├── Login.vue
│           └── SetupWizard.vue
├── shared/                     # Shared TypeScript types
│   ├── package.json
│   └── src/types.ts            # Socket.IO events, Monitor/Check models
├── Dockerfile                  # Multi-stage build
├── docker-compose.yml          # Production deployment
├── .env.example                # Environment template
└── package.json                # Root workspace config
```

## Workspace Layout

The monorepo uses npm workspaces:

```json
{
  "workspaces": ["server", "client", "shared"]
}
```

- `shared` is built first (types used by both server and client)
- `client` and `server` depend on `@uptime-detective/shared`
- The build order is: shared → client → server

## Frontend Dev Details

- **Vite** with Vue plugin and `@` alias pointing to `client/src/`
- **Tailwind CSS** with dark mode (class-based strategy)
- **Proxy config**: `/api` → `http://localhost:3300`, `/socket.io` → WS upgrade
- **Router guards**: Setup check → Auth check → Route resolution

## Backend Dev Details

- **tsx watch** for hot-reload during development
- **esbuild** via `tsc` for production builds
- **Migrations** run automatically on server start — no manual step needed
- **dotenv** loads `.env` from CWD or parent directory (monorepo root)
- **DB path** resolves relative to project root via `import.meta.url`, not CWD
