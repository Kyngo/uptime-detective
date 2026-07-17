/**
 * Shared utilities for all checkers: status transition detection,
 * incident management, Socket.IO emission, and notification dispatch.
 */
import type { Monitor, MonitorStatus } from '@uptime-detective/shared';
import type { CheckResult } from './http.js';
import { getDb } from '../../db/connection.js';
import { getIO } from '../../socket.js';
import { dispatchNotifications, type NotificationPayload } from '../notifiers/dispatcher.js';

/**
 * Persist a check result to the database.
 */
export function persistCheck(monitorId: number, result: CheckResult): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO checks (monitor_id, status, response_time, status_code, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(monitorId, result.status, result.response_time, result.status_code, result.message);
}

/**
 * Handle status transitions: create/resolve incidents and dispatch notifications.
 */
export function handleStatusTransition(monitor: Monitor, result: CheckResult): void {
  const db = getDb();

  const prevCheck = db
    .prepare('SELECT status FROM checks WHERE monitor_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET 1')
    .get(monitor.id) as { status: number } | undefined;

  const prevStatus = prevCheck?.status;
  const newStatus = result.status;

  // DOWN transition: create incident + notify
  if (newStatus === 0 && prevStatus !== 0 && prevStatus !== undefined) {
    db.prepare(`INSERT INTO incidents (monitor_id, started_at, cause) VALUES (?, datetime('now'), ?)`)
      .run(monitor.id, result.message);

    const incident = db.prepare('SELECT * FROM incidents WHERE monitor_id = ? ORDER BY id DESC LIMIT 1').get(monitor.id);
    try { getIO().emit('incident:created', incident as any); } catch {}

    const payload: NotificationPayload = {
      event: 'down',
      monitor_id: monitor.id,
      monitor_name: monitor.name,
      monitor_type: monitor.type,
      target: monitor.target,
      message: result.message,
      response_time: result.response_time,
      status_code: result.status_code,
      timestamp: new Date().toISOString(),
    };
    dispatchNotifications(monitor, payload).catch(() => {});
  }

  // RECOVERY transition: resolve open incident + notify
  if (newStatus === 1 && prevStatus === 0) {
    const open = db.prepare('SELECT id FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1').get(monitor.id) as any;
    if (open) {
      db.prepare(`UPDATE incidents SET resolved_at = datetime('now'), duration_seconds = CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER) WHERE id = ?`).run(open.id);
      const resolved = db.prepare('SELECT * FROM incidents WHERE id = ?').get(open.id);
      try { getIO().emit('incident:resolved', resolved as any); } catch {}
    }

    const payload: NotificationPayload = {
      event: 'up',
      monitor_id: monitor.id,
      monitor_name: monitor.name,
      monitor_type: monitor.type,
      target: monitor.target,
      message: 'Service recovered',
      response_time: result.response_time,
      status_code: result.status_code,
      timestamp: new Date().toISOString(),
    };
    dispatchNotifications(monitor, payload).catch(() => {});
  }

  // DEGRADED transition (TLS expiry warning)
  if (newStatus === 2 && prevStatus !== 2) {
    const payload: NotificationPayload = {
      event: 'degraded',
      monitor_id: monitor.id,
      monitor_name: monitor.name,
      monitor_type: monitor.type,
      target: monitor.target,
      message: result.message,
      response_time: result.response_time,
      status_code: result.status_code,
      timestamp: new Date().toISOString(),
    };
    dispatchNotifications(monitor, payload).catch(() => {});
  }
}

/**
 * Emit a check result via Socket.IO to subscribed clients.
 */
export function emitCheckResult(monitorId: number, result: CheckResult): void {
  try {
    const io = getIO();
    const statusMap: Record<number, MonitorStatus> = { 0: 'down', 1: 'up', 2: 'degraded', 3: 'maintenance' };

    const data = {
      monitor_id: monitorId,
      status: statusMap[result.status] || 'down',
      check: {
        monitor_id: monitorId,
        status: result.status,
        response_time: result.response_time,
        status_code: result.status_code,
        message: result.message,
        created_at: new Date().toISOString(),
      } as any,
    };

    // Emit to all (dashboard uses this)
    io.emit('monitor:status', data);
  } catch {}
}
