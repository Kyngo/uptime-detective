/**
 * Formatting helpers shared by bot command replies and notification messages.
 * Pure functions only — safe to use in tests and from any service.
 */
import type { MonitorStatus } from '@uptime-detective/shared';

const STATUS_EMOJI: Record<string, string> = {
  up: '🟢',
  down: '🔴',
  degraded: '🟡',
  maintenance: '🔵',
  pending: '⚪',
};

export function statusEmoji(status: string): string {
  return STATUS_EMOJI[status] ?? '⚪';
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    up: 'UP',
    down: 'DOWN',
    degraded: 'DEGRADED',
    maintenance: 'MAINTENANCE',
    pending: 'PENDING',
  };
  return labels[status] ?? status.toUpperCase();
}

/** Escape user-controlled text for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape text for Telegram MarkdownV2 parse mode. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** Human friendly duration: 45s, 2h 15m, 3d 4h. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** Relative time from an ISO/SQL timestamp: "3m ago", "in 2h", "just now". */
export function formatRelativeTime(timestamp: string | null | undefined, now: number = Date.now()): string {
  if (!timestamp) return 'never';
  const normalized = timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T') + 'Z';
  const time = Date.parse(normalized);
  if (Number.isNaN(time)) return 'unknown';

  const diff = time - now;
  const abs = Math.abs(diff);
  if (abs < 30_000) return 'just now';

  const suffix = diff < 0 ? 'ago' : 'from now';
  return `${formatDuration(abs)} ${suffix}`;
}

/** Shorten a string for one-line display. */
export function shorten(text: string, max = 48): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Split a long message into chunks below Telegram's 4096-char limit,
 * preferring line boundaries.
 */
export function splitMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > limit) {
      if (current.length > 0) chunks.push(current);
      if (line.length > limit) {
        // Hard-wrap a single long line.
        for (let offset = 0; offset < line.length; offset += limit) {
          chunks.push(line.slice(offset, offset + limit));
        }
        current = '';
        continue;
      }
      current = line;
    } else {
      current = current.length > 0 ? `${current}\n${line}` : line;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** "#12 My API" style reference. */
export function monitorRef(monitor: { id: number; name: string }): string {
  return `#${monitor.id} ${monitor.name}`;
}

/** Format a monitor status as "🟢 UP". */
export function formatStatus(status: string): string {
  return `${statusEmoji(status)} ${statusLabel(status)}`;
}

/** Narrow a status string to the shared MonitorStatus union (defaults to pending). */
export function asMonitorStatus(status: string): MonitorStatus {
  const known: MonitorStatus[] = ['up', 'down', 'degraded', 'maintenance', 'pending'];
  return known.includes(status as MonitorStatus) ? (status as MonitorStatus) : 'pending';
}
