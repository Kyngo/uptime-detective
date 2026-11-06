/**
 * Unit tests for the single-bot Telegram configuration (in-memory SQLite).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
}));

import {
  TELEGRAM_SETTING_KEYS,
  getTelegramConfig,
  getTelegramSettingsResponse,
  getTelegramSetting,
  getTelegramToken,
  getTelegramTokenSource,
  isTelegramBotEnabled,
  maskBotToken,
  setTelegramSetting,
  updateTelegramSettings,
} from '../../src/services/telegram/config.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

const VALID_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

describe('telegram config', () => {
  beforeEach(() => {
    testDb?.close();
    testDb = createDb();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is disabled by default', () => {
    const config = getTelegramConfig();
    expect(config.bot_token).toBeNull();
    expect(config.enabled).toBe(false);
    expect(config.token_source).toBe('none');
  });

  it('reads the token from settings and requires the enabled flag', () => {
    setTelegramSetting(TELEGRAM_SETTING_KEYS.token, VALID_TOKEN);
    expect(getTelegramToken()).toBe(VALID_TOKEN);
    expect(getTelegramTokenSource()).toBe('settings');
    expect(isTelegramBotEnabled()).toBe(false);

    setTelegramSetting(TELEGRAM_SETTING_KEYS.enabled, '1');
    expect(isTelegramBotEnabled()).toBe(true);
  });

  it('lets the environment token override settings and force-enable the bot', () => {
    setTelegramSetting(TELEGRAM_SETTING_KEYS.token, VALID_TOKEN);
    setTelegramSetting(TELEGRAM_SETTING_KEYS.enabled, '0');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '999:ENVTOKEN');
    vi.stubEnv('TELEGRAM_API_BASE_URL', 'http://127.0.0.1:9999/');

    const config = getTelegramConfig();
    expect(config.bot_token).toBe('999:ENVTOKEN');
    expect(config.token_source).toBe('env');
    expect(config.enabled).toBe(true);
    expect(config.api_base_url).toBe('http://127.0.0.1:9999');
  });

  it('honours TELEGRAM_BOT_ENABLED=false with an env token', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '999:ENVTOKEN');
    vi.stubEnv('TELEGRAM_BOT_ENABLED', 'false');
    expect(isTelegramBotEnabled()).toBe(false);
  });

  it('masks tokens and never includes the full token in the response', () => {
    setTelegramSetting(TELEGRAM_SETTING_KEYS.token, VALID_TOKEN);
    setTelegramSetting(TELEGRAM_SETTING_KEYS.enabled, '1');

    const response = getTelegramSettingsResponse();
    expect(response.bot_token_set).toBe(true);
    expect(response.bot_token_hint).toBe(maskBotToken(VALID_TOKEN));
    expect(JSON.stringify(response)).not.toContain(VALID_TOKEN);
    expect(response.status.configured).toBe(true);
  });

  it('rejects token changes when the token is env-managed', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '999:ENVTOKEN');
    expect(() => updateTelegramSettings({ bot_token: VALID_TOKEN })).toThrow(/environment variable/i);
  });

  it('validates token shape when saving', () => {
    expect(() => updateTelegramSettings({ bot_token: 'nope' })).toThrow(/Invalid bot token/);
    updateTelegramSettings({ bot_token: VALID_TOKEN });
    expect(getTelegramSetting(TELEGRAM_SETTING_KEYS.token)).toBe(VALID_TOKEN);
  });

  it('clears the token when set to null', () => {
    updateTelegramSettings({ bot_token: VALID_TOKEN, enabled: true });
    updateTelegramSettings({ bot_token: null });
    expect(getTelegramToken()).toBeNull();
  });

  it('validates and normalizes the web app URL', () => {
    expect(() => updateTelegramSettings({ webapp_url: 'http://example.com/app' })).toThrow(/https/i);
    expect(() => updateTelegramSettings({ webapp_url: 'not a url' })).toThrow(/valid https/i);

    updateTelegramSettings({ webapp_url: 'https://example.com/app/' });
    expect(getTelegramSetting(TELEGRAM_SETTING_KEYS.webappUrl)).toBe('https://example.com/app');
  });

  it('prefers the environment web app URL', () => {
    updateTelegramSettings({ webapp_url: 'https://settings.example.com/app' });
    vi.stubEnv('TELEGRAM_WEBAPP_URL', 'https://env.example.com/app');
    expect(getTelegramConfig().webapp_url).toBe('https://env.example.com/app');
  });
});
