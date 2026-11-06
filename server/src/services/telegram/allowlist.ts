/**
 * Telegram user allow list.
 *
 * Only users present in this table with `is_allowed = 1` may interact with the
 * bot. Unknown users are recorded (so admins can see pending access requests in
 * the web UI) but cannot execute commands.
 */
import type { TelegramUserRecord } from '@uptime-detective/shared';
import { getDb } from '../../db/connection.js';
import type { TelegramChat, TelegramUserInfo } from './types.js';

function parseRow(row: any): TelegramUserRecord {
  return {
    telegram_user_id: Number(row.telegram_user_id),
    chat_id: row.chat_id === null || row.chat_id === undefined ? null : Number(row.chat_id),
    username: row.username ?? null,
    first_name: row.first_name ?? null,
    last_name: row.last_name ?? null,
    is_allowed: Boolean(row.is_allowed),
    allowed_by: row.allowed_by === null || row.allowed_by === undefined ? null : Number(row.allowed_by),
    last_seen_at: row.last_seen_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Record that a Telegram user interacted with the bot. Never changes the
 * allow flag of an existing row.
 */
export function trackTelegramUser(actor: TelegramUserInfo, chat?: TelegramChat): TelegramUserRecord {
  const db = getDb();
  db.prepare(`
    INSERT INTO telegram_users (telegram_user_id, chat_id, username, first_name, last_name, is_allowed, last_seen_at)
    VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      chat_id = COALESCE(excluded.chat_id, telegram_users.chat_id),
      username = COALESCE(excluded.username, telegram_users.username),
      first_name = COALESCE(excluded.first_name, telegram_users.first_name),
      last_name = COALESCE(excluded.last_name, telegram_users.last_name),
      last_seen_at = datetime('now'),
      updated_at = datetime('now')
  `).run(
    actor.id,
    chat?.type === 'private' ? chat.id : null,
    actor.username ?? null,
    actor.first_name ?? null,
    actor.last_name ?? null
  );

  const row = db.prepare('SELECT * FROM telegram_users WHERE telegram_user_id = ?').get(actor.id) as any;
  return parseRow(row);
}

export function getTelegramUser(telegramUserId: number): TelegramUserRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM telegram_users WHERE telegram_user_id = ?').get(telegramUserId) as any;
  return row ? parseRow(row) : null;
}

export function isTelegramUserAllowed(telegramUserId: number): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT is_allowed FROM telegram_users WHERE telegram_user_id = ?')
    .get(telegramUserId) as { is_allowed: number } | undefined;
  return Boolean(row?.is_allowed);
}

export function listTelegramUsers(): TelegramUserRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM telegram_users ORDER BY is_allowed DESC, username ASC, telegram_user_id ASC')
    .all() as any[];
  return rows.map(parseRow);
}

export function allowTelegramUser(
  telegramUserId: number,
  opts: { username?: string | null; allowedBy?: number | null } = {}
): TelegramUserRecord {
  const db = getDb();
  db.prepare(`
    INSERT INTO telegram_users (telegram_user_id, username, is_allowed, allowed_by, last_seen_at)
    VALUES (?, ?, 1, ?, datetime('now'))
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      is_allowed = 1,
      username = COALESCE(excluded.username, telegram_users.username),
      allowed_by = COALESCE(excluded.allowed_by, telegram_users.allowed_by),
      updated_at = datetime('now')
  `).run(telegramUserId, opts.username ?? null, opts.allowedBy ?? null);

  return getTelegramUser(telegramUserId)!;
}

export function denyTelegramUser(telegramUserId: number): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE telegram_users SET is_allowed = 0, updated_at = datetime('now') WHERE telegram_user_id = ?")
    .run(telegramUserId);
  return result.changes > 0;
}

/**
 * Bootstrap allow list from `TELEGRAM_ADMIN_USER_IDS` (comma separated IDs).
 * Used so a fresh installation can be controlled before anyone is allowed
 * through the web UI.
 */
export function bootstrapTelegramAdmins(): number[] {
  const raw = process.env.TELEGRAM_ADMIN_USER_IDS || '';
  const ids = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  const added: number[] = [];
  for (const id of ids) {
    if (!isTelegramUserAllowed(id)) {
      allowTelegramUser(id, { allowedBy: null });
      added.push(id);
    }
  }

  if (added.length > 0) {
    console.log(`[telegram] Bootstrapped ${added.length} admin user(s) from TELEGRAM_ADMIN_USER_IDS`);
  }

  return added;
}
