import cron, { type ScheduledTask } from 'node-cron';
import type { Monitor } from '@uptime-detective/shared';
import { getDb } from '../db/connection.js';
import { executeCheck } from './checker/index.js';

// Map of monitor ID → cron task
const jobs = new Map<number, ScheduledTask>();

/**
 * Convert interval in seconds to a cron expression.
 * node-cron supports seconds syntax for sub-minute intervals.
 * 
 * For intervals that don't map cleanly to cron (e.g. 90s, 45m),
 * we use the closest valid cron schedule.
 */
function intervalToCron(seconds: number): string {
  if (seconds < 60) {
    // Run every N seconds (works for divisors of 60: 20, 30, etc.)
    return `*/${seconds} * * * * *`;
  }

  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `0 */${minutes} * * * *`;
  }

  const hours = Math.round(seconds / 3600);
  return `0 0 */${hours} * * *`;
}

/**
 * Start a monitoring job for a single monitor.
 */
export function startMonitorJob(monitor: Monitor): void {
  // Stop existing job if present
  stopMonitorJob(monitor.id);

  if (!monitor.active) return;

  const cronExpr = intervalToCron(monitor.interval);
  
  const task = cron.schedule(cronExpr, async () => {
    try {
      // Re-fetch monitor from DB to get latest config
      const db = getDb();
      const current = db
        .prepare('SELECT * FROM monitors WHERE id = ? AND active = 1')
        .get(monitor.id) as any;

      if (!current) {
        stopMonitorJob(monitor.id);
        return;
      }

      // Parse JSON fields
      const mon: Monitor = {
        ...current,
        config: typeof current.config === 'string' ? JSON.parse(current.config) : current.config,
        tags: typeof current.tags === 'string' ? JSON.parse(current.tags) : current.tags,
        active: Boolean(current.active),
      };

      await executeCheck(mon);
    } catch (err) {
      console.error(`[scheduler] Error checking monitor ${monitor.id}:`, err);
    }
  });

  jobs.set(monitor.id, task);
  console.log(`[scheduler] Started job for monitor ${monitor.id} (${monitor.name}) every ${monitor.interval}s`);
}

/**
 * Stop a monitoring job.
 */
export function stopMonitorJob(monitorId: number): void {
  const task = jobs.get(monitorId);
  if (task) {
    task.stop();
    jobs.delete(monitorId);
    console.log(`[scheduler] Stopped job for monitor ${monitorId}`);
  }
}

/**
 * Update a monitor's job (stop + restart with new config).
 */
export function updateMonitorJob(monitor: Monitor): void {
  stopMonitorJob(monitor.id);
  if (monitor.active) {
    startMonitorJob(monitor);
  }
}

/**
 * Start all active monitors on server boot.
 */
export function startAllMonitors(): void {
  const db = getDb();
  const monitors = db.prepare('SELECT * FROM monitors WHERE active = 1').all() as any[];

  console.log(`[scheduler] Starting ${monitors.length} active monitor(s)...`);

  for (const row of monitors) {
    const monitor: Monitor = {
      ...row,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
      active: Boolean(row.active),
    };
    startMonitorJob(monitor);
  }
}

/**
 * Stop all monitoring jobs (for graceful shutdown).
 */
export function stopAllMonitors(): void {
  for (const [id, task] of jobs) {
    task.stop();
  }
  jobs.clear();
  console.log('[scheduler] All monitor jobs stopped');
}

/**
 * Get the count of currently running jobs.
 */
export function getRunningJobCount(): number {
  return jobs.size;
}
