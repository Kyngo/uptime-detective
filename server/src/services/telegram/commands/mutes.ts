/**
 * Mute commands: /mute (with inline duration keyboard) and /unmute.
 *
 * `/mute all` creates the global mute; per-monitor mutes and the global mute
 * are independent rows, and the monitor-specific one wins while it is active.
 * `/unmute all` clears every active mute.
 */
import { getMonitor } from '../../monitor-service.js';
import {
  formatMuteRemaining,
  listActiveMutes,
  muteMonitor,
  parseDuration,
  unmuteMonitor,
} from '../../mutes.js';
import { escapeHtml, formatDuration } from '../format.js';
import type { InlineKeyboardMarkup } from '../types.js';
import { editOrSend, sendReply, type CommandContext } from './context.js';
import { describeMonitorLookupFailure, resolveMonitorRef } from './refs.js';

/** Maximum mute duration accepted from callback buttons (30 days, see mutes.ts). */
const MAX_MUTE_SECONDS = 30 * 86_400;

const INVALID_DURATION_MESSAGE =
  '⚠️ Invalid duration. Use e.g. <code>15m</code>, <code>1h</code>, <code>4h</code>, <code>12h</code>, <code>1d</code> (a bare number is minutes).';

function formatUntil(mutedUntil: string): string {
  const normalized = mutedUntil.includes('T') ? mutedUntil : `${mutedUntil.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return mutedUntil;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function muteDurationKeyboard(target: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '15m', callback_data: `mt:${target}:900` },
        { text: '1h', callback_data: `mt:${target}:3600` },
        { text: '4h', callback_data: `mt:${target}:14400` },
      ],
      [
        { text: '12h', callback_data: `mt:${target}:43200` },
        { text: '1d', callback_data: `mt:${target}:86400` },
      ],
    ],
  };
}

function muteTargetLine(monitorId: number | null, monitorLabel: string | null): string {
  return monitorId === null ? 'all monitors' : monitorLabel ?? `monitor #${monitorId}`;
}

function mutedReply(monitorId: number | null, label: string, durationMs: number, mutedUntil: string): string {
  return `🔇 Muted ${label} for ${formatDuration(durationMs)} (until ${formatUntil(mutedUntil)}).`;
}

/** `/mute <monitor|all> [duration]` */
export async function handleMute(
  ctx: CommandContext,
  _args: string,
  tokens: string[]
): Promise<void> {
  if (tokens.length === 0) {
    await sendReply(
      ctx,
      '⚠️ Usage: /mute &lt;monitor|all&gt; [duration]\nExamples: /mute #12 1h, /mute all 15m, /mute "My Cool API" 2h'
    );
    return;
  }

  // Monitor references may contain spaces. With two or more tokens the final
  // token is a duration when it parses as one; otherwise the whole remainder is
  // the monitor reference (a single token is always a reference so ids such as
  // `/mute 12` keep working).
  const lastToken = tokens[tokens.length - 1];
  const parsedDuration = tokens.length >= 2 ? parseDuration(lastToken) : null;
  const refTokens = parsedDuration !== null ? tokens.slice(0, -1) : tokens;
  const ref = refTokens.join(' ');

  let monitorId: number | null = null;
  let label: string;

  if (ref.toLowerCase() === 'all') {
    label = muteTargetLine(null, null);
  } else {
    const resolution = resolveMonitorRef(ref);
    if (!resolution.ok) {
      // A valid monitor reference followed by an unparseable token is almost
      // certainly a bad duration: report that instead of "monitor not found".
      if (parsedDuration === null && refTokens.length > 1 && resolveMonitorRef(refTokens[0]).ok) {
        await sendReply(ctx, INVALID_DURATION_MESSAGE);
        return;
      }
      await sendReply(ctx, describeMonitorLookupFailure(resolution));
      return;
    }
    monitorId = resolution.monitor.id;
    label = `<b>#${resolution.monitor.id} ${escapeHtml(resolution.monitor.name)}</b>`;
  }

  if (parsedDuration === null) {
    const target = monitorId === null ? 'all' : String(monitorId);
    await sendReply(
      ctx,
      `🔇 <b>Mute notifications</b>\n\nTarget: ${label}\n\nFor how long?`,
      muteDurationKeyboard(target)
    );
    return;
  }

  const mute = muteMonitor(monitorId, parsedDuration, `tg:${ctx.user.id}`);
  await sendReply(ctx, mutedReply(monitorId, label, parsedDuration, mute.muted_until));
}

/** `mt:<target>:<seconds>` callback — mute for a duration chosen from the keyboard. */
export async function handleMuteCallback(
  ctx: CommandContext,
  target: string,
  seconds: number
): Promise<void> {
  let monitorId: number | null = null;
  let label: string;

  if (target.toLowerCase() === 'all') {
    label = muteTargetLine(null, null);
  } else {
    const id = Number(target);
    if (!Number.isInteger(id) || id <= 0) {
      await editOrSend(ctx, '⚠️ Invalid mute target.');
      return;
    }
    const monitor = getMonitor(id);
    if (!monitor) {
      await editOrSend(ctx, '⚠️ Monitor not found (it may have been deleted).');
      return;
    }
    monitorId = monitor.id;
    label = `<b>#${monitor.id} ${escapeHtml(monitor.name)}</b>`;
  }

  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_MUTE_SECONDS) {
    await editOrSend(ctx, '⚠️ Invalid mute duration.');
    return;
  }

  const durationMs = seconds * 1000;
  const mute = muteMonitor(monitorId, durationMs, `tg:${ctx.user.id}`);
  await editOrSend(ctx, mutedReply(monitorId, label, durationMs, mute.muted_until));
}

/** `/unmute <monitor|all>` */
export async function handleUnmute(
  ctx: CommandContext,
  _args: string,
  tokens: string[]
): Promise<void> {
  if (tokens.length === 0) {
    await sendReply(
      ctx,
      '⚠️ Usage: /unmute &lt;monitor|all&gt;\nExamples: /unmute #12, /unmute all'
    );
    return;
  }

  if (tokens.length === 1 && tokens[0].toLowerCase() === 'all') {
    const active = listActiveMutes();
    if (active.length === 0) {
      await sendReply(ctx, 'ℹ️ No active mutes.');
      return;
    }
    let removed = 0;
    for (const mute of active) {
      removed += unmuteMonitor(mute.monitor_id);
    }
    await sendReply(ctx, `🔔 Cleared ${removed} active mute${removed === 1 ? '' : 's'}.`);
    return;
  }

  const resolution = resolveMonitorRef(tokens.join(' '));
  if (!resolution.ok) {
    await sendReply(ctx, describeMonitorLookupFailure(resolution));
    return;
  }

  const { id, name } = resolution.monitor;
  const removed = unmuteMonitor(id);
  if (removed === 0) {
    await sendReply(ctx, `ℹ️ <b>#${id} ${escapeHtml(name)}</b> is not muted.`);
    return;
  }
  await sendReply(ctx, `🔔 Unmuted <b>#${id} ${escapeHtml(name)}</b>.`);
}

/** Remaining time label for one monitor (used by tests and the /status view). */
export function describeMuteRemaining(mutedUntil: string): string {
  return formatMuteRemaining(mutedUntil);
}
