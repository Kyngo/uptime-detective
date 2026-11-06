/**
 * Notification mutes.
 *
 * A mute suppresses notifications for a single monitor (`monitor_id`) or for
 * every monitor (`monitor_id = NULL`). Checks keep running while muted; only
 * alert dispatch is suppressed.
 */
import type { MonitorMute } from '@uptime-detective/shared';
import { getDb } from '../db/connection.js';
import { formatDuration } from './telegram/format.js';

function toIsoNow(): string {
  return new Date().toISOString();
}

function parseMuteRow(row: any): MonitorMute {
  return {
    id: Number(row.id),
    monitor_id: row.monitor_id === null || row.monitor_id === undefined ? null : Number(row.monitor_id),
    muted_until: row.muted_until,
    muted_by: row.muted_by ?? null,
    created_at: row.created_at,
  };
}

/**
 * Parse a human duration: "15m", "2h", "1d", "1w" or a bare number of minutes.
 * Returns milliseconds, or null when the input is invalid.
 */
export function parseDuration(input: string): number | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;

  const match = value.match(/^(\d+)\s*(s|m|h|d|w|min|mins|hour|hours|day|days|week|weeks)?$/);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = match[2] || 'm';
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    h: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
    w: 604_800_000,
    week: 604_800_000,
    weeks: 604_800_000,
  };

  const ms = amount * multipliers[unit];
  // Cap at 30 days to avoid accidental permanent mutes.
  const MAX = 30 * 86_400_000;
  return Math.min(ms, MAX);
}

/** Create/replace a mute for one monitor, or for all monitors when id is null. */
export function muteMonitor(monitorId: number | null, durationMs: number, mutedBy: string): MonitorMute {
  const db = getDb();
  const mutedUntil = new Date(Date.now() + durationMs).toISOString();

  // Opportunistically prune expired mutes so the table does not grow forever.
  cleanupExpiredMutes();

  const removeExisting = db.prepare(
    monitorId === null
      ? 'DELETE FROM monitor_mutes WHERE monitor_id IS NULL'
      : 'DELETE FROM monitor_mutes WHERE monitor_id = ?'
  );
  if (monitorId === null) removeExisting.run();
  else removeExisting.run(monitorId);

  const result = db
    .prepare('INSERT INTO monitor_mutes (monitor_id, muted_until, muted_by) VALUES (?, ?, ?)')
    .run(monitorId, mutedUntil, mutedBy);

  const row = db.prepare('SELECT * FROM monitor_mutes WHERE id = ?').get(result.lastInsertRowid) as any;
  return parseMuteRow(row);
}

/** Remove mute(s) for a monitor (or all monitors when null). Returns rows removed. */
export function unmuteMonitor(monitorId: number | null): number {
  const db = getDb();
  cleanupExpiredMutes();
  const result = db
    .prepare(
      monitorId === null
        ? 'DELETE FROM monitor_mutes WHERE monitor_id IS NULL'
        : 'DELETE FROM monitor_mutes WHERE monitor_id = ?'
    )
    .run(...(monitorId === null ? [] : [monitorId]));
  return result.changes;
}

/**
 * Active mute affecting a monitor: a monitor-specific mute wins over the
 * global ("all monitors") mute.
 */
export function getActiveMute(monitorId: number): { monitor_id: number | null; muted_until: string } | null {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT monitor_id, muted_until FROM monitor_mutes
      WHERE (monitor_id = ? OR monitor_id IS NULL) AND muted_until > ?
      ORDER BY CASE WHEN monitor_id IS NULL THEN 1 ELSE 0 END ASC
      LIMIT 1
    `)
    .get(monitorId, toIsoNow()) as { monitor_id: number | null; muted_until: string } | undefined;

  return row ?? null;
}

export function isMonitorMuted(monitorId: number): boolean {
  return getActiveMute(monitorId) !== null;
}

export function listActiveMutes(): MonitorMute[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM monitor_mutes WHERE muted_until > ? ORDER BY created_at DESC')
    .all(toIsoNow()) as any[];
  return rows.map(parseMuteRow);
}

/** Remove expired mute rows. Safe to call periodically. */
export function cleanupExpiredMutes(): void {
  const db = getDb();
  db.prepare('DELETE FROM monitor_mutes WHERE muted_until <= ?').run(toIsoNow());
}

export function formatMuteRemaining(mutedUntil: string): string {
  const until = Date.parse(mutedUntil.includes('T') ? mutedUntil : mutedUntil.replace(' ', 'T') + 'Z');
  if (Number.isNaN(until)) return 'unknown';
  const remaining = until - Date.now();
  if (remaining <= 0) return 'expired';
  return formatDuration(remaining);
}
