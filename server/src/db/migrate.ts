import { getDb } from './connection.js';

interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Optional data migration executed in the same transaction as `sql`. */
  run?: (db: any) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin' CHECK(role IN ('admin', 'viewer')),
        api_token TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS monitors (
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

      CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        status INTEGER NOT NULL CHECK(status IN (0, 1, 2, 3)),
        response_time INTEGER,
        status_code INTEGER,
        message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        started_at DATETIME NOT NULL,
        resolved_at DATETIME,
        duration_seconds INTEGER,
        cause TEXT
      );

      CREATE TABLE IF NOT EXISTS status_pages (
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

      CREATE TABLE IF NOT EXISTS status_page_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status_page_id INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
        group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
        monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
        sort_order INTEGER DEFAULT 0,
        CHECK ((group_id IS NOT NULL AND monitor_id IS NULL) OR (group_id IS NULL AND monitor_id IS NOT NULL))
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('webhook', 'email', 'slack', 'discord', 'telegram')),
        config JSON NOT NULL DEFAULT '{}',
        is_default INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS monitor_notifications (
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        PRIMARY KEY (monitor_id, notification_id)
      );

      CREATE TABLE IF NOT EXISTS maintenance_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        start_at DATETIME NOT NULL,
        end_at DATETIME NOT NULL,
        recurring TEXT CHECK(recurring IN ('daily', 'weekly', 'monthly') OR recurring IS NULL),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS maintenance_monitors (
        maintenance_id INTEGER NOT NULL REFERENCES maintenance_windows(id) ON DELETE CASCADE,
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        PRIMARY KEY (maintenance_id, monitor_id)
      );

      -- Performance indexes
      CREATE INDEX IF NOT EXISTS idx_checks_monitor_created ON checks(monitor_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_checks_created ON checks(created_at);
      CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON incidents(monitor_id);
      CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(monitor_id, resolved_at) WHERE resolved_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_monitors_group ON monitors(group_id);
      CREATE INDEX IF NOT EXISTS idx_monitors_active ON monitors(active) WHERE active = 1;

      -- Migration tracking table
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 2,
    name: 'add_settings_table',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 3,
    name: 'telegram_bot_and_mutes',
    sql: `
      CREATE TABLE IF NOT EXISTS telegram_users (
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
      CREATE INDEX IF NOT EXISTS idx_telegram_users_allowed ON telegram_users(is_allowed);

      CREATE TABLE IF NOT EXISTS monitor_mutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
        muted_until DATETIME NOT NULL,
        muted_by TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_monitor_mutes_monitor ON monitor_mutes(monitor_id);
      CREATE INDEX IF NOT EXISTS idx_monitor_mutes_until ON monitor_mutes(muted_until);
    `,
    run: (db) => {
      // Single-bot migration: import the first legacy Telegram notification
      // channel token into instance settings and drop it from the channel
      // config (the channel only keeps its chat_id).
      try {
        const existing = db
          .prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'")
          .get() as { value: string } | undefined;
        if (existing?.value) return;

        const channels = db
          .prepare("SELECT id, config FROM notifications WHERE type = 'telegram'")
          .all() as { id: number; config: string }[];

        for (const channel of channels) {
          try {
            const config = typeof channel.config === 'string' ? JSON.parse(channel.config) : channel.config;
            if (!config || typeof config !== 'object' || !config.bot_token) continue;

            db.prepare(
              `INSERT INTO settings (key, value, updated_at) VALUES ('telegram_bot_token', ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
            ).run(String(config.bot_token));

            const { bot_token: _importedToken, ...rest } = config;
            db.prepare('UPDATE notifications SET config = ? WHERE id = ?').run(JSON.stringify(rest), channel.id);

            db.prepare(
              `INSERT INTO settings (key, value, updated_at) VALUES ('telegram_bot_enabled', '1', datetime('now'))
               ON CONFLICT(key) DO NOTHING`
            ).run();

            console.log(`[db] Imported legacy Telegram bot token into instance settings (channel #${channel.id})`);
            break;
          } catch (err: any) {
            console.warn(`[db] Skipped malformed Telegram channel #${channel.id}: ${err.message}`);
          }
        }
      } catch (err: any) {
        console.warn(`[db] Legacy Telegram bot token import skipped: ${err.message}`);
      }
    },
  },
];

export function migrate(): void {
  const db = getDb();

  // Ensure migrations table exists (for first run)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM _migrations')
      .all()
      .map((row: any) => row.version)
  );

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));

  if (pending.length === 0) {
    console.log('[db] Schema is up to date');
    return;
  }

  const applyMigration = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    if (migration.run) {
      migration.run(db);
    }
    db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
      migration.version,
      migration.name
    );
  });

  for (const migration of pending) {
    console.log(`[db] Applying migration ${migration.version}: ${migration.name}`);
    applyMigration(migration);
  }

  console.log(`[db] Applied ${pending.length} migration(s)`);
}

// Run directly with: tsx src/db/migrate.ts
const isDirectRun = process.argv[1]?.includes('migrate');
if (isDirectRun) {
  migrate();
  console.log('[db] Migration complete');
  process.exit(0);
}
