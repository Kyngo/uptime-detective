/**
 * Shared monitor CRUD + status helpers.
 *
 * Both the REST API (`routes/monitors.ts`) and the Telegram bot commands use
 * this service so behaviour (scheduler lifecycle, socket events, validation)
 * stays identical regardless of the entry point.
 */
import crypto from 'crypto';
import type {
  CreateMonitorRequest,
  Monitor,
  MonitorStatus,
  MonitorWithStatus,
  MonitorType,
  UpdateMonitorRequest,
} from '@uptime-detective/shared';
import { getDb } from '../db/connection.js';
import { startMonitorJob, stopMonitorJob, updateMonitorJob } from './scheduler.js';
import { getIO } from '../socket.js';
import {
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_RECOVERY_THRESHOLD,
  MAX_THRESHOLD,
  normalizeMonitorStatus,
  normalizeThreshold,
} from './checker/thresholds.js';

export const VALID_MONITOR_TYPES: MonitorType[] = ['http', 'icmp', 'dns', 'tls', 'tcp', 'heartbeat'];

export interface MonitorStatusInfo {
  status: MonitorStatus;
  lastCheck: any;
  uptime24h: number | null;
  avgResponseTime: number | null;
}

export interface MonitorListFilters {
  group_id?: number;
  tag?: string;
  active?: boolean;
}

export function parseMonitorRow(row: any): Monitor {
  return {
    ...row,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {},
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags || [],
    active: Boolean(row.active),
    failure_threshold: normalizeThreshold(row.failure_threshold, DEFAULT_FAILURE_THRESHOLD),
    recovery_threshold: normalizeThreshold(row.recovery_threshold, DEFAULT_RECOVERY_THRESHOLD),
    status: normalizeMonitorStatus(row.status),
  };
}

/** Validate the minimal fields required to create a monitor. Returns an error message or null. */
export function validateCreateMonitorInput(
  input: Partial<CreateMonitorRequest>
): string | null {
  if (!input.name || !input.type || !input.target) {
    return 'name, type, and target are required';
  }
  if (!VALID_MONITOR_TYPES.includes(input.type)) {
    return `type must be one of: ${VALID_MONITOR_TYPES.join(', ')}`;
  }

  for (const field of ['failure_threshold', 'recovery_threshold'] as const) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_THRESHOLD) {
      return `${field} must be an integer between 1 and ${MAX_THRESHOLD}`;
    }
  }

  return null;
}

function emitMonitorEvent(event: 'monitor:created' | 'monitor:updated' | 'monitor:deleted', payload: any): void {
  try {
    const io = getIO() as any;
    io.emit(event, payload);
  } catch {
    // Socket.IO may not be initialised (tests, CLI usage) — never fail CRUD.
  }
}

export function getMonitorStatusInfo(
  monitorId: number,
  reportedStatus?: MonitorStatus
): MonitorStatusInfo {
  const db = getDb();

  const lastCheck = db
    .prepare('SELECT * FROM checks WHERE monitor_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(monitorId) as any;

  // `status` is the confirmed/reported status: it only changes once the
  // monitor's failure or recovery threshold has been reached. Checks are still
  // recorded individually and remain visible in the history.
  let status: MonitorStatus;
  if (reportedStatus !== undefined) {
    status = normalizeMonitorStatus(reportedStatus);
  } else {
    const monitorRow = db
      .prepare('SELECT status FROM monitors WHERE id = ?')
      .get(monitorId) as { status: string } | undefined;
    status = monitorRow ? normalizeMonitorStatus(monitorRow.status) : 'pending';
  }

  const uptimeRow = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) as successful
    FROM checks
    WHERE monitor_id = ? AND created_at >= datetime('now', '-1 day')
  `).get(monitorId) as { total: number; successful: number };

  const uptime24h = uptimeRow.total > 0 ? (uptimeRow.successful / uptimeRow.total) * 100 : null;

  const avgRow = db.prepare(`
    SELECT AVG(response_time) as avg_rt
    FROM checks
    WHERE monitor_id = ? AND created_at >= datetime('now', '-1 day') AND response_time IS NOT NULL
  `).get(monitorId) as { avg_rt: number | null };

  return {
    status,
    lastCheck,
    uptime24h: uptime24h !== null ? Math.round(uptime24h * 100) / 100 : null,
    avgResponseTime: avgRow.avg_rt !== null ? Math.round(avgRow.avg_rt) : null,
  };
}

export function listMonitorsWithStatus(filters: MonitorListFilters = {}): MonitorWithStatus[] {
  const db = getDb();

  let query = 'SELECT * FROM monitors WHERE 1=1';
  const params: any[] = [];

  if (filters.group_id !== undefined) {
    query += ' AND group_id = ?';
    params.push(filters.group_id);
  }

  if (filters.active !== undefined) {
    query += ' AND active = ?';
    params.push(filters.active ? 1 : 0);
  }

  query += ' ORDER BY name ASC';

  const rows = db.prepare(query).all(...params) as any[];
  const monitors: MonitorWithStatus[] = rows.map((row) => {
    const monitor = parseMonitorRow(row);
    const { status, lastCheck, uptime24h, avgResponseTime } = getMonitorStatusInfo(monitor.id, monitor.status);

    return {
      ...monitor,
      current_status: status,
      last_check: lastCheck || null,
      uptime_24h: uptime24h,
      avg_response_time: avgResponseTime,
    };
  });

  if (filters.tag) {
    return monitors.filter((monitor) => monitor.tags.includes(filters.tag as string));
  }

  return monitors;
}

export function getMonitorWithStatus(id: number): MonitorWithStatus | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as any;
  if (!row) return null;

  const monitor = parseMonitorRow(row);
  const { status, lastCheck, uptime24h, avgResponseTime } = getMonitorStatusInfo(monitor.id, monitor.status);

  return {
    ...monitor,
    current_status: status,
    last_check: lastCheck || null,
    uptime_24h: uptime24h,
    avg_response_time: avgResponseTime,
  };
}

export function getMonitor(id: number): Monitor | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as any;
  return row ? parseMonitorRow(row) : null;
}

export function createMonitor(input: CreateMonitorRequest): Monitor {
  const db = getDb();

  // Generate heartbeat token for heartbeat monitors
  const heartbeatToken = input.type === 'heartbeat' ? crypto.randomBytes(16).toString('hex') : null;

  const result = db.prepare(`
    INSERT INTO monitors (name, type, target, interval, timeout, retries, retry_interval, failure_threshold, recovery_threshold, config, group_id, tags, active, heartbeat_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name,
    input.type,
    input.target,
    input.interval || 60,
    input.timeout || 10000,
    input.retries || 1,
    input.retry_interval || 30,
    normalizeThreshold(input.failure_threshold, DEFAULT_FAILURE_THRESHOLD),
    normalizeThreshold(input.recovery_threshold, DEFAULT_RECOVERY_THRESHOLD),
    JSON.stringify(input.config || {}),
    input.group_id || null,
    JSON.stringify(input.tags || []),
    input.active !== false ? 1 : 0,
    heartbeatToken
  );

  const monitor = parseMonitorRow(
    db.prepare('SELECT * FROM monitors WHERE id = ?').get(result.lastInsertRowid) as any
  );

  if (monitor.active) {
    startMonitorJob(monitor);
  }

  emitMonitorEvent('monitor:created', monitor);
  return monitor;
}

export function updateMonitor(id: number, input: UpdateMonitorRequest): Monitor | null {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as any;
  if (!existing) return null;

  const typeChangedToHeartbeat =
    input.type === 'heartbeat' && existing.type !== 'heartbeat' && !existing.heartbeat_token;
  const heartbeatToken = typeChangedToHeartbeat
    ? crypto.randomBytes(16).toString('hex')
    : existing.heartbeat_token ?? null;

  db.prepare(`
    UPDATE monitors SET
      name = COALESCE(?, name),
      type = COALESCE(?, type),
      target = COALESCE(?, target),
      interval = COALESCE(?, interval),
      timeout = COALESCE(?, timeout),
      retries = COALESCE(?, retries),
      retry_interval = COALESCE(?, retry_interval),
      failure_threshold = COALESCE(?, failure_threshold),
      recovery_threshold = COALESCE(?, recovery_threshold),
      config = COALESCE(?, config),
      group_id = ?,
      tags = COALESCE(?, tags),
      active = COALESCE(?, active),
      heartbeat_token = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    input.name ?? null,
    input.type ?? null,
    input.target ?? null,
    input.interval !== undefined ? input.interval : null,
    input.timeout !== undefined ? input.timeout : null,
    input.retries !== undefined ? input.retries : null,
    input.retry_interval !== undefined ? input.retry_interval : null,
    input.failure_threshold !== undefined
      ? normalizeThreshold(input.failure_threshold, DEFAULT_FAILURE_THRESHOLD)
      : null,
    input.recovery_threshold !== undefined
      ? normalizeThreshold(input.recovery_threshold, DEFAULT_RECOVERY_THRESHOLD)
      : null,
    input.config ? JSON.stringify(input.config) : null,
    input.group_id !== undefined ? input.group_id : existing.group_id,
    input.tags ? JSON.stringify(input.tags) : null,
    input.active !== undefined ? (input.active ? 1 : 0) : null,
    heartbeatToken,
    id
  );

  const monitor = parseMonitorRow(db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as any);

  updateMonitorJob(monitor);
  emitMonitorEvent('monitor:updated', monitor);

  return monitor;
}

export function deleteMonitor(id: number): boolean {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM monitors WHERE id = ?').get(id);
  if (!existing) return false;

  stopMonitorJob(id);
  db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
  emitMonitorEvent('monitor:deleted', { monitor_id: id });

  return true;
}

export function setMonitorActive(id: number, active: boolean): Monitor | null {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM monitors WHERE id = ?').get(id) as any;
  if (!existing) return null;

  db.prepare("UPDATE monitors SET active = ?, updated_at = datetime('now') WHERE id = ?").run(active ? 1 : 0, id);
  stopMonitorJob(id);

  const monitor = parseMonitorRow(db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as any);
  if (active) startMonitorJob(monitor);

  emitMonitorEvent('monitor:updated', monitor);
  return monitor;
}

/** Heartbeat push URL for heartbeat monitors (needs APP_URL to be absolute). */
export function getHeartbeatUrl(monitor: Monitor): string | null {
  if (monitor.type !== 'heartbeat' || !monitor.heartbeat_token) return null;
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  const path = `/api/v1/heartbeat/${monitor.heartbeat_token}`;
  return base ? `${base}${path}` : path;
}
