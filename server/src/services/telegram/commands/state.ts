/**
 * In-memory interactive state for the Telegram bot.
 *
 * Telegram users get at most one pending action at a time (an `/add` wizard, an
 * `/edit` awaiting a target or a `/remove` confirmation). States expire after
 * two minutes, and `/cancel` clears them. Nothing here is persisted: restarting
 * the bot simply drops half-finished wizards, which is acceptable.
 */
import crypto from 'crypto';
import type { MonitorType } from '@uptime-detective/shared';

/** Pending interactive action TTL (2 minutes). */
export const PENDING_TTL_MS = 2 * 60_000;

/** `/remove` confirmation TTL (120 seconds). */
export const REMOVE_CONFIRM_TTL_MS = 120_000;

export type AddWizardStep = 'type' | 'target' | 'name' | 'group' | 'interval';

export interface AddWizardState {
  kind: 'add';
  step: AddWizardStep;
  monitorType?: MonitorType;
  target?: string;
  name?: string;
  groupId?: number | null;
}

export interface EditTargetState {
  kind: 'edit';
  step: 'target';
  monitorId: number;
  monitorName: string;
  monitorType: MonitorType;
}

export interface RemoveConfirmState {
  kind: 'remove';
  step: 'confirm';
  monitorId: number;
  monitorName: string;
  nonce: string;
}

export type PendingState = AddWizardState | EditTargetState | RemoveConfirmState;

interface PendingEntry {
  state: PendingState;
  expiresAt: number;
}

const pendingByUser = new Map<number, PendingEntry>();

/** Store (or replace) the pending action of a user, refreshing its TTL. */
export function setPendingState(userId: number, state: PendingState): void {
  pendingByUser.set(userId, { state, expiresAt: Date.now() + PENDING_TTL_MS });
}

/**
 * Read a user's pending action; expired entries are dropped and reported as
 * missing.
 */
export function getPendingState(userId: number): PendingState | null {
  const entry = pendingByUser.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pendingByUser.delete(userId);
    return null;
  }
  return entry.state;
}

/** Drop the user's pending action. Returns true when there was one. */
export function clearPendingState(userId: number): boolean {
  return pendingByUser.delete(userId);
}

/** Random single-use token embedded in `/remove` confirmation buttons. */
export function newNonce(): string {
  return crypto.randomBytes(8).toString('hex');
}

/** Drop all pending states (used by tests and shutdown). */
export function clearAllPendingStates(): void {
  pendingByUser.clear();
}
