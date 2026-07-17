/**
 * Unit tests for scheduler utilities (intervalToCron)
 *
 * intervalToCron is not exported, so we test it indirectly through startMonitorJob
 * behavior, or we use a workaround to access it. Here we test the cron logic
 * by importing the module and verifying the scheduling behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/db/connection.js', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() })),
  })),
}));

vi.mock('../../src/services/checker/index.js', () => ({
  executeCheck: vi.fn(async () => {}),
}));

const mockSchedule = vi.fn(() => ({ stop: vi.fn() }));
vi.mock('node-cron', () => ({
  default: { schedule: (...args: any[]) => mockSchedule(...args) },
  schedule: (...args: any[]) => mockSchedule(...args),
}));

import { startMonitorJob, stopMonitorJob, getRunningJobCount, stopAllMonitors } from '../../src/services/scheduler.js';
import type { Monitor } from '@uptime-detective/shared';

function createMonitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: 1, name: 'Test', type: 'http', target: 'https://example.com',
    interval: 60, timeout: 5000, retries: 0, retry_interval: 5, config: {},
    group_id: null, tags: [], active: true, heartbeat_token: null,
    created_at: '', updated_at: '',
    ...overrides,
  };
}

describe('Scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopAllMonitors();
  });

  describe('intervalToCron (via startMonitorJob)', () => {
    it('schedules sub-minute intervals as seconds cron', () => {
      startMonitorJob(createMonitor({ interval: 30 }));
      expect(mockSchedule).toHaveBeenCalledWith('*/30 * * * * *', expect.any(Function));
    });

    it('schedules minute intervals', () => {
      startMonitorJob(createMonitor({ interval: 60 }));
      expect(mockSchedule).toHaveBeenCalledWith('0 */1 * * * *', expect.any(Function));
    });

    it('schedules 5-minute intervals', () => {
      startMonitorJob(createMonitor({ interval: 300 }));
      expect(mockSchedule).toHaveBeenCalledWith('0 */5 * * * *', expect.any(Function));
    });

    it('schedules hour intervals', () => {
      startMonitorJob(createMonitor({ interval: 3600 }));
      expect(mockSchedule).toHaveBeenCalledWith('0 0 */1 * * *', expect.any(Function));
    });

    it('does not schedule inactive monitors', () => {
      startMonitorJob(createMonitor({ active: false }));
      expect(mockSchedule).not.toHaveBeenCalled();
    });
  });

  describe('job management', () => {
    it('starts a job and tracks it', () => {
      startMonitorJob(createMonitor({ id: 10 }));
      expect(getRunningJobCount()).toBe(1);
    });

    it('stops a running job', () => {
      startMonitorJob(createMonitor({ id: 10 }));
      stopMonitorJob(10);
      expect(getRunningJobCount()).toBe(0);
    });

    it('stopMonitorJob is no-op for non-existent job', () => {
      expect(() => stopMonitorJob(999)).not.toThrow();
    });

    it('replaces existing job when restarted', () => {
      startMonitorJob(createMonitor({ id: 5 }));
      startMonitorJob(createMonitor({ id: 5, interval: 120 }));
      expect(getRunningJobCount()).toBe(1);
      // Second call should schedule with 2-minute interval
      expect(mockSchedule).toHaveBeenLastCalledWith('0 */2 * * * *', expect.any(Function));
    });

    it('stopAllMonitors clears all jobs', () => {
      startMonitorJob(createMonitor({ id: 1 }));
      startMonitorJob(createMonitor({ id: 2 }));
      startMonitorJob(createMonitor({ id: 3 }));
      expect(getRunningJobCount()).toBe(3);
      stopAllMonitors();
      expect(getRunningJobCount()).toBe(0);
    });
  });
});
