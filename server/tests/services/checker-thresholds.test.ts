/**
 * Failure / recovery confirmation thresholds.
 *
 * Pure threshold logic plus integration-style tests of the persisted monitor
 * status, incident creation/resolution and notification dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { CheckStatus, Monitor, MonitorStatus } from '@uptime-detective/shared';

let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
}));

const socketMock = vi.hoisted(() => ({ io: { emit: vi.fn() } }));
vi.mock('../../src/socket.js', () => ({
  getIO: () => socketMock.io,
}));

const dispatchMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/services/notifiers/dispatcher.js', () => ({
  dispatchNotifications: dispatchMock,
}));

import {
  computeNextMonitorStatus,
  normalizeMonitorStatus,
  normalizeThreshold,
} from '../../src/services/checker/thresholds.js';
import { processCheckResult } from '../../src/services/checker/shared.js';
import {
  createMonitor,
  getMonitorWithStatus,
  updateMonitor,
  validateCreateMonitorInput,
} from '../../src/services/monitor-service.js';

const SCHEMA = `
  CREATE TABLE monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    target TEXT NOT NULL,
    interval INTEGER DEFAULT 60,
    timeout INTEGER DEFAULT 10000,
    retries INTEGER DEFAULT 1,
    retry_interval INTEGER DEFAULT 30,
    failure_threshold INTEGER NOT NULL DEFAULT 1,
    recovery_threshold INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    config JSON DEFAULT '{}',
    group_id INTEGER,
    tags JSON DEFAULT '[]',
    active INTEGER DEFAULT 1,
    heartbeat_token TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    status INTEGER NOT NULL,
    response_time INTEGER,
    status_code INTEGER,
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    started_at DATETIME NOT NULL,
    resolved_at DATETIME,
    duration_seconds INTEGER,
    cause TEXT
  );
`;

function seedMonitor(options: {
  failureThreshold?: number;
  recoveryThreshold?: number;
  status?: MonitorStatus;
} = {}): Monitor {
  const info = testDb
    .prepare(`
      INSERT INTO monitors (name, type, target, failure_threshold, recovery_threshold, status)
      VALUES ('Test', 'http', 'https://example.com', ?, ?, ?)
    `)
    .run(
      options.failureThreshold ?? 1,
      options.recoveryThreshold ?? 1,
      options.status ?? 'pending'
    );

  return testDb.prepare('SELECT * FROM monitors WHERE id = ?').get(info.lastInsertRowid) as any;
}

function runCheck(monitor: Monitor, status: CheckStatus, message: string | null = null): MonitorStatus {
  return processCheckResult(monitor, {
    status,
    response_time: 10,
    status_code: status === 1 ? 200 : 503,
    message,
  });
}

function reportedStatus(monitorId: number): string {
  return (testDb.prepare('SELECT status FROM monitors WHERE id = ?').get(monitorId) as any).status;
}

function checkCount(monitorId: number): number {
  return (testDb.prepare('SELECT COUNT(*) AS n FROM checks WHERE monitor_id = ?').get(monitorId) as any).n;
}

function incidentCount(monitorId: number): number {
  return (testDb.prepare('SELECT COUNT(*) AS n FROM incidents WHERE monitor_id = ?').get(monitorId) as any).n;
}

function openIncidentCount(monitorId: number): number {
  return (
    testDb
      .prepare('SELECT COUNT(*) AS n FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL')
      .get(monitorId) as any
  ).n;
}

function notifiedEvents(): string[] {
  return dispatchMock.mock.calls.map((call) => (call[1] as any).event);
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  testDb.exec(SCHEMA);
  dispatchMock.mockClear();
  socketMock.io.emit.mockClear();
});

afterEach(() => {
  testDb.close();
});

describe('threshold helpers', () => {
  it('normalizes thresholds into the supported range', () => {
    expect(normalizeThreshold(undefined)).toBe(1);
    expect(normalizeThreshold(3)).toBe(3);
    expect(normalizeThreshold('4')).toBe(4);
    expect(normalizeThreshold(0)).toBe(1);
    expect(normalizeThreshold(-2)).toBe(1);
    expect(normalizeThreshold(3.9)).toBe(3);
    expect(normalizeThreshold('nope', 2)).toBe(2);
    expect(normalizeThreshold(1000)).toBe(100);
  });

  it('normalizes unknown monitor statuses to pending', () => {
    expect(normalizeMonitorStatus('up')).toBe('up');
    expect(normalizeMonitorStatus('down')).toBe('down');
    expect(normalizeMonitorStatus(null)).toBe('pending');
    expect(normalizeMonitorStatus('bogus')).toBe('pending');
  });

  it('validates threshold input on monitor create', () => {
    const base = { name: 'Test', type: 'http' as const, target: 'https://example.com' };

    expect(validateCreateMonitorInput(base)).toBeNull();
    expect(
      validateCreateMonitorInput({ ...base, failure_threshold: 3, recovery_threshold: 2 })
    ).toBeNull();
    expect(validateCreateMonitorInput({ ...base, failure_threshold: 0 })).toContain(
      'failure_threshold'
    );
    expect(validateCreateMonitorInput({ ...base, failure_threshold: 1.5 })).toContain(
      'failure_threshold'
    );
    expect(validateCreateMonitorInput({ ...base, recovery_threshold: 101 })).toContain(
      'recovery_threshold'
    );
  });

  it('keeps the previous status while the failure threshold is not reached', () => {
    expect(
      computeNextMonitorStatus({
        previousStatus: 'up',
        checkStatus: 0,
        consecutiveFailures: 2,
        consecutiveSuccesses: 0,
        failureThreshold: 3,
        recoveryThreshold: 1,
      })
    ).toBe('up');
  });

  it('reports down when the failure threshold is reached', () => {
    expect(
      computeNextMonitorStatus({
        previousStatus: 'up',
        checkStatus: 0,
        consecutiveFailures: 3,
        consecutiveSuccesses: 0,
        failureThreshold: 3,
        recoveryThreshold: 1,
      })
    ).toBe('down');
  });

  it('does not recover before the recovery threshold is reached', () => {
    expect(
      computeNextMonitorStatus({
        previousStatus: 'down',
        checkStatus: 1,
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
        failureThreshold: 1,
        recoveryThreshold: 2,
      })
    ).toBe('down');

    expect(
      computeNextMonitorStatus({
        previousStatus: 'down',
        checkStatus: 1,
        consecutiveFailures: 0,
        consecutiveSuccesses: 2,
        failureThreshold: 1,
        recoveryThreshold: 2,
      })
    ).toBe('up');
  });

  it('applies degraded and maintenance immediately', () => {
    expect(
      computeNextMonitorStatus({
        previousStatus: 'up',
        checkStatus: 2,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        failureThreshold: 5,
        recoveryThreshold: 5,
      })
    ).toBe('degraded');

    expect(
      computeNextMonitorStatus({
        previousStatus: 'down',
        checkStatus: 3,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        failureThreshold: 5,
        recoveryThreshold: 5,
      })
    ).toBe('maintenance');
  });
});

describe('check processing with confirmation thresholds', () => {
  it('defaults to alerting on the first failure and recovering on the first success', () => {
    const monitor = seedMonitor({ status: 'up' });

    expect(runCheck(monitor, 0, 'Connection refused')).toBe('down');
    expect(reportedStatus(monitor.id)).toBe('down');
    expect(incidentCount(monitor.id)).toBe(1);
    expect(openIncidentCount(monitor.id)).toBe(1);
    expect(notifiedEvents()).toEqual(['down']);

    expect(runCheck(monitor, 1)).toBe('up');
    expect(reportedStatus(monitor.id)).toBe('up');
    expect(openIncidentCount(monitor.id)).toBe(0);
    expect(notifiedEvents()).toEqual(['down', 'up']);
  });

  it('suppresses a single failed check when the failure threshold is higher', () => {
    const monitor = seedMonitor({ failureThreshold: 3, status: 'up' });

    expect(runCheck(monitor, 0, 'blip 1')).toBe('up');
    expect(runCheck(monitor, 0, 'blip 2')).toBe('up');
    expect(incidentCount(monitor.id)).toBe(0);
    expect(notifiedEvents()).toEqual([]);

    // Checks are still recorded, so the failures stay visible in history.
    expect(checkCount(monitor.id)).toBe(2);

    expect(runCheck(monitor, 0, 'blip 3')).toBe('down');
    expect(incidentCount(monitor.id)).toBe(1);
    expect(notifiedEvents()).toEqual(['down']);
  });

  it('reports recovery only after the recovery threshold', () => {
    const monitor = seedMonitor({ failureThreshold: 1, recoveryThreshold: 2, status: 'up' });

    expect(runCheck(monitor, 0, 'down')).toBe('down');
    expect(runCheck(monitor, 1)).toBe('down');
    expect(openIncidentCount(monitor.id)).toBe(1);
    expect(notifiedEvents()).toEqual(['down']);

    expect(runCheck(monitor, 1)).toBe('up');
    expect(openIncidentCount(monitor.id)).toBe(0);
    expect(notifiedEvents()).toEqual(['down', 'up']);
  });

  it('resets the failure streak on a successful check', () => {
    const monitor = seedMonitor({ failureThreshold: 3, status: 'up' });

    expect(runCheck(monitor, 0)).toBe('up');
    expect(runCheck(monitor, 0)).toBe('up');
    expect(runCheck(monitor, 1)).toBe('up');
    expect(runCheck(monitor, 0)).toBe('up');
    expect(runCheck(monitor, 0)).toBe('up');
    expect(reportedStatus(monitor.id)).toBe('up');

    expect(runCheck(monitor, 0)).toBe('down');
  });

  it('creates an incident when a new monitor is confirmed down', () => {
    const monitor = seedMonitor({ failureThreshold: 2, status: 'pending' });

    expect(runCheck(monitor, 0)).toBe('pending');
    expect(incidentCount(monitor.id)).toBe(0);

    expect(runCheck(monitor, 0)).toBe('down');
    expect(incidentCount(monitor.id)).toBe(1);
    expect(notifiedEvents()).toEqual(['down']);
  });

  it('broadcasts the confirmed status, not the raw check status', () => {
    const monitor = seedMonitor({ failureThreshold: 2, status: 'up' });

    runCheck(monitor, 0, 'one-off error');

    const payload = socketMock.io.emit.mock.calls.find((call) => call[0] === 'monitor:status')?.[1] as any;
    expect(payload.status).toBe('up');
    expect(payload.check.status).toBe(0);
  });

  it('reports TLS degraded immediately and notifies once', () => {
    const monitor = seedMonitor({ failureThreshold: 5, status: 'up' });

    expect(runCheck(monitor, 2, 'Certificate expires in 5 days')).toBe('degraded');
    expect(reportedStatus(monitor.id)).toBe('degraded');
    expect(notifiedEvents()).toEqual(['degraded']);

    expect(runCheck(monitor, 2, 'Certificate expires in 4 days')).toBe('degraded');
    expect(notifiedEvents()).toEqual(['degraded']);
  });
});

describe('monitor CRUD and status reporting', () => {
  it('creates and updates thresholds', () => {
    const created = createMonitor({
      name: 'Thresholded',
      type: 'http',
      target: 'https://example.com',
      active: false,
      failure_threshold: 3,
      recovery_threshold: 2,
    });

    expect(created.failure_threshold).toBe(3);
    expect(created.recovery_threshold).toBe(2);
    expect(created.status).toBe('pending');

    const updated = updateMonitor(created.id, { failure_threshold: 5 });
    expect(updated?.failure_threshold).toBe(5);
    expect(updated?.recovery_threshold).toBe(2);
  });

  it('exposes the confirmed status while reporting the raw last check', () => {
    const monitor = createMonitor({
      name: 'Thresholded',
      type: 'http',
      target: 'https://example.com',
      active: false,
      failure_threshold: 3,
    });

    runCheck(monitor, 0, 'failure 1');
    runCheck(monitor, 0, 'failure 2');

    const partial = getMonitorWithStatus(monitor.id);
    expect(partial?.current_status).toBe('pending');
    expect(partial?.last_check?.status).toBe(0);

    runCheck(monitor, 0, 'failure 3');
    expect(getMonitorWithStatus(monitor.id)?.current_status).toBe('down');
  });
});
