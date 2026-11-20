/**
 * Shared utilities for all checkers: status transition detection,
 * incident management, Socket.IO emission, and notification dispatch.
 */
import type { CheckStatus, Monitor, MonitorStatus } from '@uptime-detective/shared';
import type { CheckResult } from './http.js';
import { getDb } from '../../db/connection.js';
import { getIO } from '../../socket.js';
import { dispatchNotifications, type NotificationPayload } from '../notifiers/dispatcher.js';
import {
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_RECOVERY_THRESHOLD,
  computeNextMonitorStatus,
  normalizeMonitorStatus,
  normalizeThreshold,
} from './thresholds.js';

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

/** Count consecutive checks with `status`, ending at the most recent check. */
function countConsecutiveChecks(monitorId: number, status: CheckStatus, limit: number): number {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT status FROM checks WHERE monitor_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    )
    .all(monitorId, limit) as { status: number }[];

  let count = 0;
  for (const row of rows) {
    if (Number(row.status) !== status) break;
    count++;
  }
  return count;
}

/**
 * Handle status transitions: create/resolve incidents and dispatch notifications.
 *
 * The reported status only changes once the monitor's confirmation thresholds
 * are met. Returns the resulting reported status.
 */
export function handleStatusTransition(monitor: Monitor, result: CheckResult): MonitorStatus {
  const db = getDb();

  const row = db
    .prepare('SELECT status, failure_threshold, recovery_threshold FROM monitors WHERE id = ?')
    .get(monitor.id) as
    | { status: string | null; failure_threshold: number | null; recovery_threshold: number | null }
    | undefined;

  const prevStatus = normalizeMonitorStatus(row?.status ?? monitor.status);
  const failureThreshold = normalizeThreshold(
    row?.failure_threshold ?? monitor.failure_threshold,
    DEFAULT_FAILURE_THRESHOLD
  );
  const recoveryThreshold = normalizeThreshold(
    row?.recovery_threshold ?? monitor.recovery_threshold,
    DEFAULT_RECOVERY_THRESHOLD
  );

  // Count only the current streak; the just-persisted check is the newest row.
  const consecutiveFailures =
    result.status === 0 ? countConsecutiveChecks(monitor.id, 0, failureThreshold) : 0;
  const consecutiveSuccesses =
    result.status === 1 ? countConsecutiveChecks(monitor.id, 1, recoveryThreshold) : 0;

  const nextStatus = computeNextMonitorStatus({
    previousStatus: prevStatus,
    checkStatus: result.status,
    consecutiveFailures,
    consecutiveSuccesses,
    failureThreshold,
    recoveryThreshold,
  });

  if (nextStatus === prevStatus) return nextStatus;

  db.prepare('UPDATE monitors SET status = ? WHERE id = ?').run(nextStatus, monitor.id);

  // DOWN transition: create incident + notify
  if (nextStatus === 'down') {
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
  if (nextStatus === 'up' && prevStatus === 'down') {
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
  if (nextStatus === 'degraded') {
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

  return nextStatus;
}

/**
 * Persist a check, apply failure/recovery thresholds, emit transitions and
 * broadcast the result. Every checker uses this so behaviour is identical
 * across monitor types.
 */
export function processCheckResult(monitor: Monitor, result: CheckResult): MonitorStatus {
  persistCheck(monitor.id, result);
  const status = handleStatusTransition(monitor, result);
  emitCheckResult(monitor.id, result, status);
  return status;
}

/**
 * Emit a check result via Socket.IO to subscribed clients.
 */
export function emitCheckResult(
  monitorId: number,
  result: CheckResult,
  reportedStatus: MonitorStatus
): void {
  try {
    const io = getIO();

    const data = {
      monitor_id: monitorId,
      status: reportedStatus,
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
