/**
 * Unit tests for notification mutes (in-memory SQLite).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
}));

import {
  cleanupExpiredMutes,
  formatMuteRemaining,
  getActiveMute,
  isMonitorMuted,
  listActiveMutes,
  muteMonitor,
  parseDuration,
  unmuteMonitor,
} from '../../src/services/mutes.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE monitor_mutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER,
      muted_until DATETIME NOT NULL,
      muted_by TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

describe('mutes', () => {
  beforeEach(() => {
    testDb?.close();
    testDb = createDb();
  });

  describe('parseDuration', () => {
    it('parses common duration formats', () => {
      expect(parseDuration('30s')).toBe(30_000);
      expect(parseDuration('15m')).toBe(15 * 60_000);
      expect(parseDuration('2h')).toBe(2 * 3_600_000);
      expect(parseDuration('1d')).toBe(86_400_000);
      expect(parseDuration('1w')).toBe(604_800_000);
      expect(parseDuration(' 5M ')).toBe(5 * 60_000);
    });

    it('treats a bare number as minutes', () => {
      expect(parseDuration('60')).toBe(60 * 60_000);
    });

    it('caps at 30 days', () => {
      expect(parseDuration('90d')).toBe(30 * 86_400_000);
    });

    it('rejects invalid input', () => {
      expect(parseDuration('')).toBeNull();
      expect(parseDuration('abc')).toBeNull();
      expect(parseDuration('0h')).toBeNull();
      expect(parseDuration('-5m')).toBeNull();
      expect(parseDuration('5y')).toBeNull();
    });
  });

  it('mutes a single monitor and reports it', () => {
    const mute = muteMonitor(5, 60_000, 'telegram:1');
    expect(mute.monitor_id).toBe(5);
    expect(mute.muted_by).toBe('telegram:1');
    expect(new Date(mute.muted_until).getTime()).toBeGreaterThan(Date.now());

    expect(isMonitorMuted(5)).toBe(true);
    expect(isMonitorMuted(6)).toBe(false);
    expect(getActiveMute(5)?.monitor_id).toBe(5);
  });

  it('replaces the previous mute for the same target', () => {
    muteMonitor(5, 60_000, 'a');
    muteMonitor(5, 120_000, 'b');
    expect(listActiveMutes()).toHaveLength(1);
  });

  it('global mute applies to every monitor and is overridden by a specific mute', () => {
    muteMonitor(null, 60_000, 'telegram:1');
    expect(isMonitorMuted(1)).toBe(true);
    expect(isMonitorMuted(99)).toBe(true);

    const specific = muteMonitor(3, 120_000, 'telegram:2');
    expect(getActiveMute(3)?.monitor_id).toBe(3);
    expect(getActiveMute(3)?.muted_until).toBe(specific.muted_until);
    // Other monitors still use the global mute.
    expect(getActiveMute(4)?.monitor_id).toBeNull();
  });

  it('unmutes one target or the global mute', () => {
    muteMonitor(5, 60_000, 'a');
    expect(unmuteMonitor(5)).toBe(1);
    expect(isMonitorMuted(5)).toBe(false);

    muteMonitor(null, 60_000, 'a');
    expect(unmuteMonitor(null)).toBe(1);
    expect(isMonitorMuted(1)).toBe(false);
  });

  it('ignores and cleans up expired mutes', () => {
    testDb
      .prepare("INSERT INTO monitor_mutes (monitor_id, muted_until, muted_by) VALUES (5, ?, 'old')")
      .run(new Date(Date.now() - 60_000).toISOString());

    expect(isMonitorMuted(5)).toBe(false);
    cleanupExpiredMutes();
    expect(listActiveMutes()).toHaveLength(0);
  });

  it('formats remaining mute time', () => {
    const remaining = formatMuteRemaining(new Date(Date.now() + 90 * 60_000).toISOString());
    expect(remaining).toMatch(/^1h (29|30)m$/);
    expect(formatMuteRemaining(new Date(Date.now() - 60_000).toISOString())).toBe('expired');
  });
});
