import type { Monitor } from '@uptime-detective/shared';
import type { CheckResult } from './http.js';
import { getDb } from '../../db/connection.js';
import { persistCheck, handleStatusTransition, emitCheckResult } from './shared.js';

/**
 * Heartbeat (push) monitor checker.
 * Runs on schedule to verify a heartbeat was received within 2x the interval.
 */
export async function executeHeartbeatCheck(monitor: Monitor): Promise<void> {
  const db = getDb();

  const lastBeat = db.prepare(`
    SELECT created_at FROM checks WHERE monitor_id = ? AND status = 1 ORDER BY created_at DESC LIMIT 1
  `).get(monitor.id) as { created_at: string } | undefined;

  let result: CheckResult;

  if (!lastBeat) {
    const monitorAge = Date.now() - new Date(monitor.created_at).getTime();
    const gracePeriod = monitor.interval * 2 * 1000;

    if (monitorAge < gracePeriod) {
      result = { status: 1, response_time: null, status_code: null, message: 'Waiting for first heartbeat...' };
    } else {
      result = { status: 0, response_time: null, status_code: null, message: 'No heartbeat received' };
    }
  } else {
    const elapsed = Date.now() - new Date(lastBeat.created_at).getTime();
    const maxAllowed = monitor.interval * 2 * 1000;

    if (elapsed > maxAllowed) {
      result = { status: 0, response_time: null, status_code: null, message: `Heartbeat missed — last received ${Math.round(elapsed / 1000)}s ago (max: ${monitor.interval * 2}s)` };
    } else {
      result = { status: 1, response_time: Math.round(elapsed), status_code: null, message: `Last heartbeat ${Math.round(elapsed / 1000)}s ago` };
    }
  }

  persistCheck(monitor.id, result);
  handleStatusTransition(monitor, result);
  emitCheckResult(monitor.id, result);
}

/**
 * Record a heartbeat push from an external service.
 */
export function recordHeartbeat(monitor: Monitor): void {
  const db = getDb();
  const result: CheckResult = { status: 1, response_time: null, status_code: null, message: 'Heartbeat received' };

  persistCheck(monitor.id, result);

  // If previous was DOWN, resolve incident via shared handler
  const prev = db.prepare('SELECT status FROM checks WHERE monitor_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET 1').get(monitor.id) as { status: number } | undefined;
  if (prev?.status === 0) {
    handleStatusTransition(monitor, result);
  }

  emitCheckResult(monitor.id, result);
}
