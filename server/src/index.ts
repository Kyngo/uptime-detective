import dotenv from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Load .env — try cwd first, then parent (monorepo root)
const localEnv = resolve(process.cwd(), '.env');
const parentEnv = resolve(process.cwd(), '..', '.env');

if (existsSync(localEnv)) {
  dotenv.config({ path: localEnv });
} else if (existsSync(parentEnv)) {
  dotenv.config({ path: parentEnv });
}

import { createServer } from 'http';
import { createApp } from './app.js';
import { setupSocketIO } from './socket.js';
import { migrate } from './db/migrate.js';
import { getDb, closeDb } from './db/connection.js';
import { startAllMonitors, stopAllMonitors } from './services/scheduler.js';

const PORT = parseInt(process.env.PORT || '3300', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Security: Refuse to start with known-insecure JWT secrets in production
const KNOWN_INSECURE_SECRETS = [
  'change-me',
  'change-me-to-a-random-string',
  'dev-secret-change-me',
  'please-change-this-secret',
];

function validateJwtSecret(): void {
  const secret = process.env.JWT_SECRET;
  if (!secret || KNOWN_INSECURE_SECRETS.includes(secret)) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[FATAL] JWT_SECRET is not set or uses a known default value.');
      console.error('[FATAL] Set a strong, random JWT_SECRET environment variable before running in production.');
      process.exit(1);
    }
    console.warn('[WARN] JWT_SECRET is not set or uses a default — acceptable in development only.');
  }
}

validateJwtSecret();

async function main() {
  // Run database migrations on startup
  migrate();

  // Verify DB connection
  getDb();
  console.log('[db] Connected to SQLite');

  // Create Express app and HTTP server
  const app = createApp();
  const httpServer = createServer(app);

  // Setup Socket.IO
  setupSocketIO(httpServer);
  console.log('[socket] Socket.IO ready');

  // Import and register routes
  const { authRouter } = await import('./routes/auth.js');
  const { monitorsRouter } = await import('./routes/monitors.js');
  const { heartbeatRouter } = await import('./routes/heartbeat.js');
  const { groupsRouter } = await import('./routes/groups.js');
  const { statusPagesRouter } = await import('./routes/status-pages.js');
  const { publicStatusRouter } = await import('./routes/public-status.js');
  const { notificationsRouter } = await import('./routes/notifications.js');
  const { maintenanceRouter } = await import('./routes/maintenance.js');
  const { setupRouter } = await import('./routes/setup.js');

  app.use('/api/v1/setup', setupRouter); // Public — no auth required
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1', heartbeatRouter); // Public — no auth required
  app.use('/api/v1', publicStatusRouter); // Public — no auth required
  app.use('/api/v1', monitorsRouter);
  app.use('/api/v1', groupsRouter);
  app.use('/api/v1', statusPagesRouter);
  app.use('/api/v1', notificationsRouter);
  app.use('/api/v1', maintenanceRouter);

  // Start server
  httpServer.listen(PORT, HOST, () => {
    console.log(`[server] Uptime Detective running at http://${HOST}:${PORT}`);
    console.log(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);

    // Start all active monitors after server is listening
    startAllMonitors();
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[server] Shutting down...');
    stopAllMonitors();
    httpServer.close(() => {
      closeDb();
      console.log('[server] Goodbye!');
      process.exit(0);
    });

    // Force exit after 5 seconds
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
