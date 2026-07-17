import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

let db: Database.Database | null = null;

// Project root is 2 levels up from server/src/db/
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

export function getDb(): Database.Database {
  if (db) return db;

  const rawPath = process.env.DB_PATH || './data/uptime-detective.db';
  // Resolve relative paths from project root, not CWD
  const dbPath = isAbsolute(rawPath) ? rawPath : resolve(PROJECT_ROOT, rawPath);

  // Ensure the directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
