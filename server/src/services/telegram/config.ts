/**
 * Single-bot configuration for the instance-wide Telegram bot.
 *
 * Resolution order:
 *  - Bot token:  `TELEGRAM_BOT_TOKEN` env var  →  `settings.telegram_bot_token`
 *  - Web app URL: `TELEGRAM_WEBAPP_URL` env var →  `settings.telegram_webapp_url`
 *  - API base:   `TELEGRAM_API_BASE_URL` env var (default https://api.telegram.org)
 *
 * Only one bot is supported per instance. The same token is used both to control
 * the instance (chat commands) and to send notifications.
 */
import type {
  TelegramBotSettingsResponse,
  TelegramBotStatus,
  TelegramTokenSource,
  UpdateTelegramSettingsRequest,
} from '@uptime-detective/shared';
import { getDb } from '../../db/connection.js';

export const TELEGRAM_API_BASE_DEFAULT = 'https://api.telegram.org';

export const TELEGRAM_SETTING_KEYS = {
  enabled: 'telegram_bot_enabled',
  token: 'telegram_bot_token',
  username: 'telegram_bot_username',
  webappUrl: 'telegram_webapp_url',
} as const;

export class TelegramConfigError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TelegramConfigError';
    this.status = status;
  }
}

export interface ResolvedTelegramConfig {
  enabled: boolean;
  bot_token: string | null;
  bot_username: string | null;
  webapp_url: string | null;
  api_base_url: string;
  token_source: TelegramTokenSource;
}

function envValue(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function envFlagDisabled(name: string): boolean {
  const value = envValue(name);
  return value === '0' || value?.toLowerCase() === 'false';
}

// === Settings helpers ===

export function getTelegramSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setTelegramSetting(key: string, value: string | null): void {
  const db = getDb();
  if (value === null || value === '') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
}

// === Resolution ===

export function getTelegramToken(): string | null {
  const envToken = envValue('TELEGRAM_BOT_TOKEN');
  if (envToken) return envToken;
  return getTelegramSetting(TELEGRAM_SETTING_KEYS.token);
}

export function getTelegramTokenSource(): TelegramTokenSource {
  const envToken = envValue('TELEGRAM_BOT_TOKEN');
  if (envToken) return 'env';
  return getTelegramSetting(TELEGRAM_SETTING_KEYS.token) ? 'settings' : 'none';
}

export function isTelegramBotEnabled(): boolean {
  const token = getTelegramToken();
  if (!token) return false;
  const envToken = envValue('TELEGRAM_BOT_TOKEN');
  if (envToken) {
    // An env-provided token is an explicit opt-in unless explicitly disabled.
    return !envFlagDisabled('TELEGRAM_BOT_ENABLED');
  }
  if (envFlagDisabled('TELEGRAM_BOT_ENABLED')) return false;
  return getTelegramSetting(TELEGRAM_SETTING_KEYS.enabled) === '1';
}

export function getTelegramConfig(): ResolvedTelegramConfig {
  const token = getTelegramToken();
  const tokenSource = getTelegramTokenSource();
  const webappUrl = envValue('TELEGRAM_WEBAPP_URL') || getTelegramSetting(TELEGRAM_SETTING_KEYS.webappUrl);
  const apiBaseUrl = (envValue('TELEGRAM_API_BASE_URL') || TELEGRAM_API_BASE_DEFAULT).replace(/\/+$/, '');

  return {
    enabled: isTelegramBotEnabled(),
    bot_token: token,
    bot_username: getTelegramSetting(TELEGRAM_SETTING_KEYS.username),
    webapp_url: webappUrl,
    api_base_url: apiBaseUrl,
    token_source: tokenSource,
  };
}

export function maskBotToken(token: string): string {
  if (token.length <= 8) return '…';
  const colon = token.indexOf(':');
  if (colon === -1) {
    return `${token.slice(0, 4)}…${token.slice(-4)}`;
  }
  const id = token.slice(0, colon);
  const secret = token.slice(colon + 1);
  const visibleId = id.length > 8 ? `${id.slice(0, 8)}…` : id;
  const visibleSecret = secret.length > 4 ? secret.slice(-4) : '';
  return `${visibleId}:…${visibleSecret}`;
}

/** Fallback runtime status used when the bot runtime is not loaded/available. */
export function buildTelegramStatusFallback(config: ResolvedTelegramConfig = getTelegramConfig()): TelegramBotStatus {
  return {
    configured: Boolean(config.bot_token),
    enabled: config.enabled,
    running: false,
    bot_username: config.bot_username,
    started_at: null,
    last_error: null,
    updates_processed: 0,
    token_source: config.token_source,
  };
}

export function getTelegramSettingsResponse(status?: TelegramBotStatus): TelegramBotSettingsResponse {
  const config = getTelegramConfig();
  const runtimeStatus = status ?? buildTelegramStatusFallback(config);

  return {
    enabled: config.enabled,
    bot_token_set: Boolean(config.bot_token),
    bot_token_hint: config.bot_token ? maskBotToken(config.bot_token) : null,
    bot_username: runtimeStatus.bot_username ?? config.bot_username,
    webapp_url: config.webapp_url,
    api_base_url: config.api_base_url,
    token_source: config.token_source,
    status: runtimeStatus,
  };
}

// === Updates (called by the REST API) ===

function normalizeWebappUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TelegramConfigError('Web app URL must be a valid https:// URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new TelegramConfigError('Web app URL must use https:// — Telegram requires a public HTTPS URL');
  }
  return value.replace(/\/+$/, '');
}

/**
 * Persist a settings patch. Token validation (against the Bot API) is the
 * caller's responsibility; this function only validates shape and env conflicts.
 */
export function updateTelegramSettings(patch: UpdateTelegramSettingsRequest): void {
  const envTokenManaged = envValue('TELEGRAM_BOT_TOKEN') !== null;

  if (patch.bot_token !== undefined) {
    if (envTokenManaged) {
      throw new TelegramConfigError(
        'The bot token is managed by the TELEGRAM_BOT_TOKEN environment variable and cannot be changed here'
      );
    }
    if (patch.bot_token === null || patch.bot_token.trim() === '') {
      setTelegramSetting(TELEGRAM_SETTING_KEYS.token, null);
      setTelegramSetting(TELEGRAM_SETTING_KEYS.username, null);
    } else {
      const token = patch.bot_token.trim();
      if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
        throw new TelegramConfigError('Invalid bot token format. Copy the token from @BotFather.');
      }
      setTelegramSetting(TELEGRAM_SETTING_KEYS.token, token);
    }
  }

  if (patch.webapp_url !== undefined) {
    if (patch.webapp_url === null || patch.webapp_url.trim() === '') {
      setTelegramSetting(TELEGRAM_SETTING_KEYS.webappUrl, null);
    } else {
      setTelegramSetting(TELEGRAM_SETTING_KEYS.webappUrl, normalizeWebappUrl(patch.webapp_url.trim()));
    }
  }

  if (patch.enabled !== undefined) {
    setTelegramSetting(TELEGRAM_SETTING_KEYS.enabled, patch.enabled ? '1' : '0');
  }
}
