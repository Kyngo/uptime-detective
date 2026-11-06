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

export function getMonitorStatusInfo(monitorId: number): MonitorStatusInfo {
  const db = getDb();

  const lastCheck = db
    .prepare('SELECT * FROM checks WHERE monitor_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(monitorId) as any;

  let status: MonitorStatus = 'pending';
  if (lastCheck) {
    const statusMap: Record<number, MonitorStatus> = { 0: 'down', 1: 'up', 2: 'degraded', 3: 'maintenance' };
    status = statusMap[lastCheck.status] || 'down';
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
    const { status, lastCheck, uptime24h, avgResponseTime } = getMonitorStatusInfo(monitor.id);

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
  const { status, lastCheck, uptime24h, avgResponseTime } = getMonitorStatusInfo(monitor.id);

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
    INSERT INTO monitors (name, type, target, interval, timeout, retries, retry_interval, config, group_id, tags, active, heartbeat_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name,
    input.type,
    input.target,
    input.interval || 60,
    input.timeout || 10000,
    input.retries || 1,
    input.retry_interval || 30,
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
