/**
 * Argument parsing, monitor/group reference resolution and target validation
 * shared by every bot command.
 *
 * Monitor reads go through `monitor-service` (single source of truth). Group
 * reads are plain prepared SELECTs because groups are only exposed through the
 * REST router.
 */
import type { MonitorType, MonitorWithStatus } from '@uptime-detective/shared';
import { getDb } from '../../../db/connection.js';
import { escapeHtml, shorten } from '../format.js';
import {
  VALID_MONITOR_TYPES,
  getMonitorWithStatus,
  listMonitorsWithStatus,
} from '../../monitor-service.js';

// === Command parsing ===

export interface ParsedCommand {
  command: string;
  /** Raw argument text (everything after the command, trimmed). */
  args: string;
  /** Shell-like tokens of `args` (quotes group words). */
  tokens: string[];
}

/**
 * Parse `/command[@BotName] args` text. Returns null when the text is not a
 * command.
 */
export function parseCommandText(text: string): ParsedCommand | null {
  const match = text.trim().match(/^\/([a-zA-Z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const args = (match[2] ?? '').trim();
  return { command: match[1].toLowerCase(), args, tokens: tokenizeArgs(args) };
}

/**
 * Split an argument string into tokens, supporting single/double quotes and
 * backslash escapes: `http://x "My API" group:2`.
 */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let hasContent = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (quote) {
      if (char === '\\' && index + 1 < input.length) {
        current += input[++index];
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
    } else if (/\s/.test(char)) {
      if (current.length > 0 || hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
    } else {
      current += char;
      hasContent = true;
    }
  }

  if (current.length > 0 || hasContent) tokens.push(current);
  return tokens;
}

// === Monitor references ===

export interface MonitorCandidate {
  id: number;
  name: string;
  type: string;
}

export type MonitorResolution =
  | { ok: true; monitor: MonitorWithStatus }
  | { ok: false; reason: 'missing'; input: string }
  | { ok: false; reason: 'not_found'; input: string }
  | { ok: false; reason: 'ambiguous'; input: string; candidates: MonitorCandidate[] };

function toCandidate(monitor: MonitorWithStatus): MonitorCandidate {
  return { id: monitor.id, name: monitor.name, type: monitor.type };
}

/**
 * Resolve a monitor reference:
 *  - `12` / `#12`       → monitor id
 *  - exact name         → case-insensitive exact match
 *  - unique substring   → case-insensitive partial match
 * Ambiguous references return up to 10 candidates for the caller to display.
 */
export function resolveMonitorRef(ref: string): MonitorResolution {
  const input = ref.trim();
  if (!input) return { ok: false, reason: 'missing', input: ref };

  let id: number | null = null;
  if (/^\d+$/.test(input)) id = Number(input);
  else if (/^#\d+$/.test(input)) id = Number(input.slice(1));

  if (id !== null) {
    const monitor = getMonitorWithStatus(id);
    return monitor ? { ok: true, monitor } : { ok: false, reason: 'not_found', input };
  }

  const all = listMonitorsWithStatus();
  const needle = input.toLowerCase();

  const exact = all.filter((monitor) => monitor.name.toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, monitor: exact[0] };
  if (exact.length > 1) {
    return { ok: false, reason: 'ambiguous', input, candidates: exact.slice(0, 10).map(toCandidate) };
  }

  const partial = all.filter((monitor) => monitor.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { ok: true, monitor: partial[0] };
  if (partial.length === 0) return { ok: false, reason: 'not_found', input };
  return { ok: false, reason: 'ambiguous', input, candidates: partial.slice(0, 10).map(toCandidate) };
}

/** Turn a failed monitor lookup into a user-facing HTML message. */
export function describeMonitorLookupFailure(
  resolution: Extract<MonitorResolution, { ok: false }>
): string {
  const input = escapeHtml(resolution.input);
  if (resolution.reason === 'missing') {
    return '⚠️ Missing monitor reference.';
  }
  if (resolution.reason === 'not_found') {
    return `🔍 Monitor not found: <code>${input}</code>\nUse /status to list monitors.`;
  }
  const candidates = resolution.candidates
    .map((candidate) => `• <b>#${candidate.id}</b> ${escapeHtml(candidate.name)} (${candidate.type})`)
    .join('\n');
  return `🔍 Multiple monitors match <code>${input}</code>:\n${candidates}\n\nUse one of these IDs or #IDs instead.`;
}

/** Default monitor name derived from its target (used by `/add`). */
export function defaultMonitorName(_type: MonitorType, target: string): string {
  const stripped = target.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  return shorten(stripped || target, 48);
}

// === Target validation ===

export type TargetValidation = { ok: true; target: string } | { ok: false; error: string };

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253}[a-zA-Z0-9])?$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function isValidHost(host: string): boolean {
  if (!host) return false;
  if (IPV4_RE.test(host)) {
    return host.split('.').every((part) => Number(part) <= 255);
  }
  if (host.includes(':')) return /^[0-9a-fA-F:]+$/.test(host); // crude IPv6 check
  return HOSTNAME_RE.test(host);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function stripScheme(target: string): string {
  return target.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
}

/**
 * Validate (and lightly normalize) a monitor target for its type. Mirrors the
 * checks the web UI performs so one-shot `/add` never creates a broken monitor.
 */
export function validateTargetForType(type: MonitorType, target: string): TargetValidation {
  const value = (target || '').trim();
  if (!value) return { ok: false, error: 'Target cannot be empty.' };

  switch (type) {
    case 'http': {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return { ok: false, error: 'HTTP target must be a valid http:// or https:// URL.' };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, error: 'HTTP target must use http:// or https://.' };
      }
      return { ok: true, target: value };
    }

    case 'tcp': {
      const hostPort = stripScheme(value).split('/')[0];
      const match = hostPort.match(/^(.+):(\d{1,5})$/);
      if (!match || !isValidHost(match[1]) || !isValidPort(Number(match[2]))) {
        return { ok: false, error: 'TCP target must be host:port, e.g. db.example.com:5432.' };
      }
      return { ok: true, target: `${match[1]}:${Number(match[2])}` };
    }

    case 'tls': {
      const hostPort = stripScheme(value).split('/')[0];
      const parts = hostPort.split(':');
      const host = parts[0];
      const port = parts.length > 1 ? Number(parts[1]) : 443;
      if (!isValidHost(host) || !isValidPort(port)) {
        return { ok: false, error: 'TLS target must be host or host:port, e.g. example.com:443.' };
      }
      return { ok: true, target: parts.length > 1 ? `${host}:${port}` : host };
    }

    case 'dns': {
      const host = stripScheme(value).split('/')[0].split(':')[0];
      if (!isValidHost(host)) {
        return { ok: false, error: 'DNS target must be a valid host name, e.g. example.com.' };
      }
      return { ok: true, target: host };
    }

    case 'icmp': {
      const host = stripScheme(value).split('/')[0].split(':')[0];
      if (!isValidHost(host)) {
        return { ok: false, error: 'ICMP target must be a valid host name or IP address.' };
      }
      return { ok: true, target: host };
    }

    case 'heartbeat': {
      if (value.length > 500) return { ok: false, error: 'Heartbeat target is too long.' };
      return { ok: true, target: value };
    }

    default:
      return { ok: false, error: `Unsupported monitor type: ${String(type)}` };
  }
}

/** Result of validating a wizard type token. */
export function parseMonitorType(value: string): MonitorType | null {
  const lower = value.trim().toLowerCase() as MonitorType;
  return VALID_MONITOR_TYPES.includes(lower) ? lower : null;
}

// === Groups ===

export interface GroupSummary {
  id: number;
  name: string;
  monitor_count: number;
}

export function listGroups(): GroupSummary[] {
  const rows = getDb()
    .prepare(`
      SELECT g.id, g.name,
        (SELECT COUNT(*) FROM monitors m WHERE m.group_id = g.id) AS monitor_count
      FROM groups g
      ORDER BY g.sort_order ASC, g.name ASC
    `)
    .all() as { id: number; name: string; monitor_count: number }[];
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    monitor_count: Number(row.monitor_count),
  }));
}

export function getGroupName(groupId: number): string | null {
  const row = getDb().prepare('SELECT name FROM groups WHERE id = ?').get(groupId) as
    | { name: string }
    | undefined;
  return row?.name ?? null;
}

export type GroupResolution =
  | { ok: true; group: { id: number; name: string } }
  | { ok: false; reason: 'missing' | 'not_found' | 'ambiguous'; input: string; candidates: { id: number; name: string }[] };

/** Resolve a group reference (numeric id, exact name, then unique substring). */
export function resolveGroupRef(ref: string): GroupResolution {
  const input = ref.trim();
  if (!input) return { ok: false, reason: 'missing', input: ref, candidates: [] };

  if (/^\d+$/.test(input)) {
    const row = getDb().prepare('SELECT id, name FROM groups WHERE id = ?').get(Number(input)) as
      | { id: number; name: string }
      | undefined;
    return row
      ? { ok: true, group: { id: Number(row.id), name: row.name } }
      : { ok: false, reason: 'not_found', input, candidates: [] };
  }

  const groups = listGroups();
  const needle = input.toLowerCase();

  const exact = groups.filter((group) => group.name.toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, group: { id: exact[0].id, name: exact[0].name } };
  if (exact.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      input,
      candidates: exact.map((group) => ({ id: group.id, name: group.name })),
    };
  }

  const partial = groups.filter((group) => group.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { ok: true, group: { id: partial[0].id, name: partial[0].name } };
  if (partial.length === 0) return { ok: false, reason: 'not_found', input, candidates: [] };
  return {
    ok: false,
    reason: 'ambiguous',
    input,
    candidates: partial.map((group) => ({ id: group.id, name: group.name })),
  };
}

/** Turn a failed group lookup into a user-facing HTML message. */
export function describeGroupLookupFailure(
  resolution: Extract<GroupResolution, { ok: false }>
): string {
  const input = escapeHtml(resolution.input);
  if (resolution.reason === 'missing') return '⚠️ Missing group reference.';
  if (resolution.reason === 'not_found') return `🔍 Group not found: <code>${input}</code>`;
  const candidates = resolution.candidates
    .map((group) => `• <b>#${group.id}</b> ${escapeHtml(group.name)}`)
    .join('\n');
  return `🔍 Multiple groups match <code>${input}</code>:\n${candidates}`;
}
