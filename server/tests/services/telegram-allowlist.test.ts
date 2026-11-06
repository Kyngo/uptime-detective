/**
 * Unit tests for the Telegram allow list (in-memory SQLite).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
}));

import {
  allowTelegramUser,
  bootstrapTelegramAdmins,
  denyTelegramUser,
  getTelegramUser,
  isTelegramUserAllowed,
  listTelegramUsers,
  trackTelegramUser,
} from '../../src/services/telegram/allowlist.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE telegram_users (
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
  `);
  return db;
}

describe('telegram allow list', () => {
  beforeEach(() => {
    testDb?.close();
    testDb = createDb();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('records unknown users without allowing them', () => {
    const record = trackTelegramUser({ id: 42, is_bot: false, first_name: 'Alice', username: 'alice' }, { id: 42, type: 'private' });

    expect(record.telegram_user_id).toBe(42);
    expect(record.is_allowed).toBe(false);
    expect(record.chat_id).toBe(42);
    expect(isTelegramUserAllowed(42)).toBe(false);
  });

  it('keeps the allow flag when a user interacts again', () => {
    trackTelegramUser({ id: 42, is_bot: false, first_name: 'Alice' });
    allowTelegramUser(42, { allowedBy: 1 });
    trackTelegramUser({ id: 42, is_bot: false, first_name: 'Alice', username: 'alice2' });

    const record = getTelegramUser(42)!;
    expect(record.is_allowed).toBe(true);
    expect(record.username).toBe('alice2');
  });

  it('allows, denies and re-allows users', () => {
    allowTelegramUser(7, { allowedBy: 1 });
    expect(isTelegramUserAllowed(7)).toBe(true);

    expect(denyTelegramUser(7)).toBe(true);
    expect(isTelegramUserAllowed(7)).toBe(false);
    // Row is kept so admins can see who was denied.
    expect(getTelegramUser(7)).not.toBeNull();

    allowTelegramUser(7);
    expect(isTelegramUserAllowed(7)).toBe(true);
  });

  it('deny returns false for unknown users', () => {
    expect(denyTelegramUser(1234)).toBe(false);
  });

  it('lists allowed users first', () => {
    allowTelegramUser(2, { username: 'bob' });
    trackTelegramUser({ id: 1, is_bot: false, first_name: 'Alice', username: 'alice' });

    const users = listTelegramUsers();
    expect(users.map((user) => user.telegram_user_id)).toEqual([2, 1]);
  });

  it('bootstraps admins from TELEGRAM_ADMIN_USER_IDS', () => {
    vi.stubEnv('TELEGRAM_ADMIN_USER_IDS', '11, 12, nope, 0');

    const added = bootstrapTelegramAdmins();

    expect(added).toEqual([11, 12]);
    expect(isTelegramUserAllowed(11)).toBe(true);
    expect(isTelegramUserAllowed(12)).toBe(true);
    expect(bootstrapTelegramAdmins()).toEqual([]);
  });
});
