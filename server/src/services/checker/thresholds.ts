/**
 * Failure / recovery confirmation thresholds.
 *
 * A monitor only reports DOWN after `failure_threshold` consecutive failed
 * checks, and only reports UP again after `recovery_threshold` consecutive
 * successful checks. This keeps a single blip from opening an incident and
 * immediately resolving it again (alert flapping).
 *
 * The helpers in this module are pure so they can be unit tested without a
 * database.
 */
import type { CheckStatus, MonitorStatus } from '@uptime-detective/shared';

export const DEFAULT_FAILURE_THRESHOLD = 1;
export const DEFAULT_RECOVERY_THRESHOLD = 1;

/** Upper bound keeps the consecutive-check queries bounded. */
export const MAX_THRESHOLD = 100;

const MONITOR_STATUSES: MonitorStatus[] = ['up', 'down', 'degraded', 'maintenance', 'pending'];

/** Narrow an arbitrary database value to a MonitorStatus (defaults to pending). */
export function normalizeMonitorStatus(value: unknown): MonitorStatus {
  return MONITOR_STATUSES.includes(value as MonitorStatus) ? (value as MonitorStatus) : 'pending';
}

/**
 * Coerce a configured threshold to an integer in [1, MAX_THRESHOLD].
 * Missing/invalid values fall back to `fallback`.
 */
export function normalizeThreshold(value: unknown, fallback = DEFAULT_FAILURE_THRESHOLD): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_THRESHOLD, Math.max(1, Math.trunc(parsed)));
}

export interface ThresholdInput {
  /** Last reported (confirmed) status. */
  previousStatus: MonitorStatus;
  /** Status of the check that was just recorded. */
  checkStatus: CheckStatus;
  /** Number of consecutive failed checks ending at this one. */
  consecutiveFailures: number;
  /** Number of consecutive successful checks ending at this one. */
  consecutiveSuccesses: number;
  failureThreshold: number;
  recoveryThreshold: number;
}

/**
 * Compute the reported status after a check.
 *
 * - Failures keep the previous status until the failure threshold is reached.
 * - A DOWN monitor needs `recoveryThreshold` consecutive successes to recover.
 * - DEGRADED / MAINTENANCE results apply immediately.
 */
export function computeNextMonitorStatus(input: ThresholdInput): MonitorStatus {
  const {
    previousStatus,
    checkStatus,
    consecutiveFailures,
    consecutiveSuccesses,
    failureThreshold,
    recoveryThreshold,
  } = input;

  switch (checkStatus) {
    case 0: {
      const needed = normalizeThreshold(failureThreshold, DEFAULT_FAILURE_THRESHOLD);
      return consecutiveFailures >= needed ? 'down' : previousStatus;
    }
    case 1: {
      if (previousStatus !== 'down') return 'up';
      const needed = normalizeThreshold(recoveryThreshold, DEFAULT_RECOVERY_THRESHOLD);
      return consecutiveSuccesses >= needed ? 'up' : 'down';
    }
    case 2:
      return 'degraded';
    case 3:
      return 'maintenance';
    default:
      return previousStatus;
  }
}
