/**
 * `/ping` — one-off checks that are never persisted.
 *
 * The checker `perform*Check` helpers are pure with respect to the database:
 * they only execute the check and return the result (persistence and
 * notification dispatching live in the `execute*` wrappers). That guarantees
 * `/ping` writes nothing and sends no notifications.
 *
 * Rate limit: one ping per user every 3 seconds.
 */
import type { Monitor, MonitorType } from '@uptime-detective/shared';
import { lookup } from 'dns/promises';
import { performDnsCheck } from '../../checker/dns.js';
import { isPrivateIp, performHttpCheck, type CheckResult } from '../../checker/http.js';
import { performIcmpCheck } from '../../checker/icmp.js';
import { performTcpCheck } from '../../checker/tcp.js';
import { performTlsCheck } from '../../checker/tls.js';
import { escapeHtml, formatStatus, shorten } from '../format.js';
import { sendReply, type CommandContext } from './context.js';

export const PING_RATE_LIMIT_MS = 3_000;

const lastPingAt = new Map<number, number>();

/** Clear rate-limit bookkeeping (tests). */
export function resetPingRateLimits(): void {
  lastPingAt.clear();
}

type PingCheckType = 'http' | 'tcp' | 'dns' | 'tls' | 'icmp';

interface PingTarget {
  type: PingCheckType;
  /** Normalized target passed to the checker. */
  target: string;
  /** Human label of what is being checked. */
  label: string;
}

type PingTargetResult = { ok: true; value: PingTarget } | { ok: false; error: string };

const HOST_PORT_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?:(\d{1,5})$/;

function stripPath(value: string): string {
  return value.split('/')[0];
}

/** Classify a `/ping` argument into a checker type + normalized target. */
export function classifyPingTarget(raw: string): PingTargetResult {
  const value = raw.trim();
  if (!value) return { ok: false, error: 'Send a target to check, e.g. /ping example.com' };

  const lower = value.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return { ok: true, value: { type: 'http', target: value, label: value } };
  }
  if (lower.startsWith('tcp://')) {
    const target = stripPath(value.slice('tcp://'.length));
    if (!HOST_PORT_RE.test(target)) {
      return { ok: false, error: 'TCP targets must be host:port, e.g. /ping tcp://db.example.com:5432' };
    }
    return { ok: true, value: { type: 'tcp', target, label: target } };
  }
  if (lower.startsWith('tls://')) {
    const target = stripPath(value.slice('tls://'.length));
    if (!target) return { ok: false, error: 'TLS targets must be host or host:port, e.g. /ping tls://example.com' };
    return { ok: true, value: { type: 'tls', target, label: target } };
  }
  if (lower.startsWith('dns://')) {
    const target = stripPath(value.slice('dns://'.length));
    if (!target) return { ok: false, error: 'DNS targets must be a host name, e.g. /ping dns://example.com' };
    return { ok: true, value: { type: 'dns', target, label: target } };
  }
  if (lower.startsWith('icmp://')) {
    const target = stripPath(value.slice('icmp://'.length));
    if (!target) return { ok: false, error: 'ICMP targets must be a host name or IP, e.g. /ping icmp://example.com' };
    return { ok: true, value: { type: 'icmp', target, label: target } };
  }

  if (HOST_PORT_RE.test(value)) {
    return { ok: true, value: { type: 'tcp', target: value, label: value } };
  }

  return { ok: true, value: { type: 'icmp', target: stripPath(value), label: value } };
}

const PRIVATE_TARGET_MESSAGE =
  'Blocked: target resolves to a private/reserved IP. ' +
  'Set ALLOW_PRIVATE_IPS=true to check internal services.';

/** Extract the host part from a normalized ping target. */
function pingTargetHost(target: PingTarget): string {
  return target.target
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .split(':')[0];
}

/**
 * Apply the same private-IP / SSRF protection used by HTTP monitors to every
 * `/ping` target type (the HTTP checker performs this validation itself).
 */
export async function validatePingTargetAddress(
  target: PingTarget
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (target.type === 'http') return { ok: true };
  if (process.env.ALLOW_PRIVATE_IPS === 'true') return { ok: true };

  const host = pingTargetHost(target);
  if (!host) return { ok: true };

  if (isPrivateIp(host)) return { ok: false, error: PRIVATE_TARGET_MESSAGE };

  try {
    const { address } = await lookup(host);
    if (isPrivateIp(address)) return { ok: false, error: PRIVATE_TARGET_MESSAGE };
  } catch {
    // DNS failure is reported by the check itself; do not block it here.
    return { ok: true };
  }

  return { ok: true };
}

function syntheticMonitor(type: MonitorType, target: string): Monitor {
  const now = new Date().toISOString();
  return {
    id: 0,
    name: `ping ${target}`,
    type,
    target,
    interval: 60,
    timeout: 10_000,
    retries: 0,
    retry_interval: 30,
    config: {},
    group_id: null,
    tags: [],
    active: false,
    heartbeat_token: null,
    created_at: now,
    updated_at: now,
  };
}

function checkResultToStatus(status: number): string {
  const map: Record<number, string> = { 0: 'down', 1: 'up', 2: 'degraded', 3: 'maintenance' };
  return map[status] ?? 'down';
}

async function runPingCheck(target: PingTarget): Promise<CheckResult> {
  const monitor = syntheticMonitor(target.type as MonitorType, target.target);
  switch (target.type) {
    case 'http':
      return performHttpCheck(monitor);
    case 'tcp':
      return performTcpCheck(monitor);
    case 'dns':
      return performDnsCheck(monitor);
    case 'tls':
      return performTlsCheck(monitor);
    case 'icmp':
      return performIcmpCheck(monitor);
  }
}

function buildPingReply(target: PingTarget, result: CheckResult): string {
  const lines = [
    '🏓 <b>One-off check</b>',
    `Target: <code>${escapeHtml(target.label)}</code>`,
    `Type: ${target.type.toUpperCase()}`,
    `Result: ${formatStatus(checkResultToStatus(result.status))}`,
  ];

  if (result.response_time !== null && result.response_time !== undefined) {
    lines.push(`Response: ${result.response_time}ms`);
  }
  if (result.status_code !== null && result.status_code !== undefined) {
    lines.push(`Status code: ${result.status_code}`);
  }
  if (result.message) {
    lines.push(`Message: ${escapeHtml(shorten(result.message, 200))}`);
  }
  lines.push('', '<i>Nothing was saved and no notification was sent.</i>');
  return lines.join('\n');
}

/** `/ping <target>` — run one check without touching the database. */
export async function handlePing(
  ctx: CommandContext,
  args: string,
  _tokens: string[]
): Promise<void> {
  if (!args.trim()) {
    await sendReply(
      ctx,
      '⚠️ Usage: /ping &lt;target&gt;\nExamples: /ping https://example.com, /ping tcp://host:5432, /ping dns://example.com, /ping example.com'
    );
    return;
  }

  const now = Date.now();
  const previous = lastPingAt.get(ctx.user.id);
  if (previous !== undefined && now - previous < PING_RATE_LIMIT_MS) {
    const waitSeconds = Math.ceil((PING_RATE_LIMIT_MS - (now - previous)) / 1000);
    await sendReply(ctx, `⏳ Slow down — wait ${waitSeconds}s before the next /ping.`);
    return;
  }
  lastPingAt.set(ctx.user.id, now);

  const classified = classifyPingTarget(args);
  if (!classified.ok) {
    await sendReply(ctx, `⚠️ ${escapeHtml(classified.error)}`);
    return;
  }

  const addressCheck = await validatePingTargetAddress(classified.value);
  if (!addressCheck.ok) {
    await sendReply(ctx, `⛔ ${escapeHtml(addressCheck.error)}`);
    return;
  }

  const result = await runPingCheck(classified.value);
  await sendReply(ctx, buildPingReply(classified.value, result));
}
