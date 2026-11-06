/**
 * Message builders for monitor-related bot replies (`/status`, `/info`,
 * `/remove`, `/add` summary). Pure formatting: callers pass in the data.
 */
import type { Monitor, MonitorStatus, MonitorWithStatus } from '@uptime-detective/shared';
import { formatMuteRemaining } from '../../mutes.js';
import {
  escapeHtml,
  formatDuration,
  formatRelativeTime,
  formatStatus,
  shorten,
  statusEmoji,
} from '../format.js';
import type { InlineKeyboardMarkup } from '../types.js';

export const STATUS_PAGE_SIZE = 10;

export interface StatusOverview {
  text: string;
  reply_markup?: InlineKeyboardMarkup;
  page: number;
  pages: number;
}

function formatUptime(uptime: number | null): string {
  return uptime === null ? '—' : `${uptime.toFixed(1)}%/24h`;
}

function checkStatusToMonitorStatus(status: number): MonitorStatus {
  const map: Record<number, MonitorStatus> = { 0: 'down', 1: 'up', 2: 'degraded', 3: 'maintenance' };
  return map[status] ?? 'pending';
}

/** One line of the `/status` list. */
function buildMonitorLine(monitor: MonitorWithStatus, muteRemaining: string | undefined): string {
  const emoji = statusEmoji(monitor.current_status);
  const response =
    monitor.last_check?.response_time !== null && monitor.last_check?.response_time !== undefined
      ? `${monitor.last_check.response_time}ms`
      : '—';
  const uptime = formatUptime(monitor.uptime_24h);
  const paused = monitor.active ? '' : ' · ⏸ paused';
  const muted = muteRemaining ? ` · 🔇 ${muteRemaining}` : '';

  return `${emoji} <b>#${monitor.id}</b> ${escapeHtml(shorten(monitor.name, 36))} — <code>${escapeHtml(
    shorten(monitor.target, 30)
  )}</code> — ${response} — ${uptime}${paused}${muted}`;
}

export interface StatusOverviewOptions {
  /** Pre-formatted remaining mute duration keyed by monitor id. */
  muteRemainingByMonitor: Map<number, string>;
}

/**
 * Build the paginated `/status` overview (10 monitors per page). Page is
 * 0-based and clamped to the available range.
 */
export function buildStatusOverview(
  monitors: MonitorWithStatus[],
  page: number,
  options: StatusOverviewOptions
): StatusOverview {
  const pages = Math.max(1, Math.ceil(monitors.length / STATUS_PAGE_SIZE));
  const current = Math.min(Math.max(0, Number.isFinite(page) ? page : 0), pages - 1);

  const counts: Record<string, number> = { up: 0, down: 0, degraded: 0, maintenance: 0, pending: 0 };
  let paused = 0;
  for (const monitor of monitors) {
    counts[monitor.current_status] = (counts[monitor.current_status] ?? 0) + 1;
    if (!monitor.active) paused++;
  }

  const lines = [
    '📊 <b>Monitor status</b>',
    `Total ${monitors.length} · 🟢 ${counts.up} · 🔴 ${counts.down} · 🟡 ${counts.degraded} · 🔵 ${counts.maintenance} · ⚪ ${counts.pending} · ⏸ ${paused}`,
    '',
  ];

  if (monitors.length === 0) {
    lines.push('No monitors yet. Use /add to create one.');
  } else {
    const start = current * STATUS_PAGE_SIZE;
    for (const monitor of monitors.slice(start, start + STATUS_PAGE_SIZE)) {
      lines.push(buildMonitorLine(monitor, options.muteRemainingByMonitor.get(monitor.id)));
    }
    lines.push('', `Page ${current + 1}/${pages}`);
  }

  const text = lines.join('\n');
  if (pages <= 1) return { text, page: current, pages };

  const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };
  const row = [];
  if (current > 0) row.push({ text: '◀ Prev', callback_data: `st:${current - 1}` });
  if (current < pages - 1) row.push({ text: 'Next ▶', callback_data: `st:${current + 1}` });
  if (row.length > 0) keyboard.inline_keyboard.push(row);

  return { text, reply_markup: keyboard, page: current, pages };
}

export interface LastIncident {
  started_at: string;
  resolved_at: string | null;
  duration_seconds: number | null;
}

export interface MonitorInfoOptions {
  groupName: string | null;
  lastIncident: LastIncident | null;
  mute: { monitor_id: number | null; muted_until: string } | null;
  heartbeatUrl: string | null;
}

/** Full `/info` detail message. */
export function buildMonitorInfoMessage(
  monitor: MonitorWithStatus,
  options: MonitorInfoOptions
): string {
  const lines: string[] = [
    `${statusEmoji(monitor.current_status)} <b>${escapeHtml(monitor.name)}</b> <i>(#${monitor.id})</i>`,
    `Status: ${formatStatus(monitor.current_status)}`,
    `Type: ${monitor.type.toUpperCase()}`,
    `Target: <code>${escapeHtml(monitor.target)}</code>`,
    `Group: ${options.groupName ? escapeHtml(options.groupName) : '—'}`,
    `Tags: ${monitor.tags.length > 0 ? monitor.tags.map((tag) => escapeHtml(tag)).join(', ') : '—'}`,
    `Interval: ${monitor.interval}s · Timeout: ${Math.round(monitor.timeout / 1000)}s · Retries: ${monitor.retries}`,
    `Active: ${monitor.active ? '✅ yes' : '⏸ no'}`,
  ];

  if (monitor.last_check) {
    const check = monitor.last_check;
    const details = [
      formatRelativeTime(check.created_at),
      check.response_time !== null ? `${check.response_time}ms` : null,
      check.status_code !== null ? `code ${check.status_code}` : null,
      check.status !== undefined
        ? formatStatus(checkStatusToMonitorStatus(Number(check.status)))
        : null,
      check.message ? escapeHtml(shorten(check.message, 100)) : null,
    ].filter((part): part is string => Boolean(part));
    lines.push(`Last check: ${details.join(' · ')}`);
  } else {
    lines.push('Last check: never');
  }

  lines.push(`24h uptime: ${formatUptime(monitor.uptime_24h)}`);

  if (!options.lastIncident) {
    lines.push('Last incident: none');
  } else if (options.lastIncident.resolved_at) {
    const duration =
      options.lastIncident.duration_seconds !== null
        ? formatDuration(options.lastIncident.duration_seconds * 1000)
        : 'unknown duration';
    lines.push(
      `Last incident: started ${formatRelativeTime(options.lastIncident.started_at)}, lasted ${duration} (resolved)`
    );
  } else {
    lines.push(`Last incident: ongoing since ${formatRelativeTime(options.lastIncident.started_at)}`);
  }

  if (options.mute) {
    const scope = options.mute.monitor_id === null ? 'global mute' : 'muted';
    lines.push(`Mute: 🔇 ${scope} · ${formatMuteRemaining(options.mute.muted_until)} remaining`);
  } else {
    lines.push('Mute: none');
  }

  if (options.heartbeatUrl) {
    lines.push(`Heartbeat URL:\n<code>${escapeHtml(options.heartbeatUrl)}</code>`);
  }

  return lines.join('\n');
}

/** Confirmation prompt for `/remove`, with single-use delete/cancel buttons. */
export function buildRemoveConfirmation(
  monitor: MonitorWithStatus | Monitor,
  nonce: string
): { text: string; reply_markup: InlineKeyboardMarkup } {
  const text = [
    '🗑 <b>Delete monitor?</b>',
    '',
    `<b>#${monitor.id} ${escapeHtml(monitor.name)}</b>`,
    `Type: ${monitor.type.toUpperCase()}`,
    `Target: <code>${escapeHtml(monitor.target)}</code>`,
    '',
    "This cannot be undone. Press <b>🗑 Delete</b> within 2 minutes to confirm.",
  ].join('\n');

  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🗑 Delete', callback_data: `rm:${monitor.id}:${nonce}` },
          { text: 'Cancel', callback_data: `rmx:${nonce}` },
        ],
      ],
    },
  };
}

/** Success summary after a monitor is created. */
export function buildCreatedSummary(monitor: Monitor, groupName: string | null): string {
  return [
    '✅ <b>Monitor created</b>',
    '',
    `${statusEmoji('pending')} <b>#${monitor.id} ${escapeHtml(monitor.name)}</b>`,
    `Type: ${monitor.type.toUpperCase()}`,
    `Target: <code>${escapeHtml(monitor.target)}</code>`,
    `Group: ${groupName ? escapeHtml(groupName) : '—'}`,
    `Interval: ${monitor.interval}s`,
  ].join('\n');
}
