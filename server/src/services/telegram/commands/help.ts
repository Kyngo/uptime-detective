/**
 * Informational commands: /start, /help, /status (and its pagination
 * callbacks), /groups.
 */
import type { MonitorWithStatus } from '@uptime-detective/shared';
import { isTelegramUserAllowed } from '../allowlist.js';
import { formatMuteRemaining, listActiveMutes } from '../../mutes.js';
import { escapeHtml } from '../format.js';
import { listMonitorsWithStatus } from '../../monitor-service.js';
import { BOT_COMMANDS } from './catalog.js';
import { editOrSend, sendReply, type CommandContext } from './context.js';
import { buildStatusOverview } from './format-monitor.js';
import { listGroups } from './refs.js';

/** `/start` — always replies, even for users that are not allowed yet. */
export async function handleStart(ctx: CommandContext): Promise<void> {
  const allowed = isTelegramUserAllowed(ctx.user.id);
  const name = ctx.user.first_name ? `, ${escapeHtml(ctx.user.first_name)}` : '';

  const lines = [
    `👋 <b>Welcome to Uptime Detective</b>${name}!`,
    '',
    `Your Telegram ID: <code>${ctx.user.id}</code>`,
    `Access: ${allowed ? '✅ allowed' : '⛔ not allowed'}`,
    '',
  ];

  if (allowed) {
    lines.push('Use /help to see the available commands.');
  } else {
    lines.push(
      'Ask an instance admin to allow this Telegram user ID. Once allowed, send /start again.'
    );
  }

  await sendReply(ctx, lines.join('\n'));
}

/** `/help` — command list generated from the shared catalog. */
export async function handleHelp(ctx: CommandContext): Promise<void> {
  const lines = [
    '🤖 <b>Uptime Detective bot</b>',
    '',
    ...BOT_COMMANDS.map((entry) => `/${entry.command} — ${escapeHtml(entry.description)}`),
    '',
    '<i>Monitor references: <code>12</code>, <code>#12</code>, an exact name or part of a name. Use <code>all</code> where noted.</i>',
  ];
  await sendReply(ctx, lines.join('\n'));
}

function buildMuteRemainingMap(monitors: MonitorWithStatus[]): Map<number, string> {
  const activeMutes = listActiveMutes();
  const globalMute = activeMutes.find((mute) => mute.monitor_id === null) ?? null;
  const globalRemaining = globalMute ? formatMuteRemaining(globalMute.muted_until) : null;

  const perMonitor = new Map<number, string>();
  for (const mute of activeMutes) {
    if (mute.monitor_id !== null) {
      perMonitor.set(mute.monitor_id, formatMuteRemaining(mute.muted_until));
    }
  }

  const result = new Map<number, string>();
  for (const monitor of monitors) {
    const remaining = perMonitor.get(monitor.id) ?? globalRemaining;
    if (remaining) result.set(monitor.id, remaining);
  }
  return result;
}

/** `/status` — overview + first page. */
export async function handleStatus(ctx: CommandContext): Promise<void> {
  const monitors = listMonitorsWithStatus();
  const overview = buildStatusOverview(monitors, 0, {
    muteRemainingByMonitor: buildMuteRemainingMap(monitors),
  });
  await sendReply(ctx, overview.text, overview.reply_markup);
}

/** `st:<page>` callback — edit the overview to another page. */
export async function handleStatusCallback(ctx: CommandContext, page: number): Promise<void> {
  const monitors = listMonitorsWithStatus();
  const overview = buildStatusOverview(monitors, page, {
    muteRemainingByMonitor: buildMuteRemainingMap(monitors),
  });
  await editOrSend(ctx, overview.text, overview.reply_markup);
}

/** `/groups` — group list with monitor counts. */
export async function handleGroups(ctx: CommandContext): Promise<void> {
  const groups = listGroups();

  if (groups.length === 0) {
    await sendReply(ctx, '👥 <b>Groups</b>\n\nNo groups yet. Create groups in the web UI, then add monitors to them.');
    return;
  }

  const lines = ['👥 <b>Groups</b>', ''];
  for (const group of groups) {
    const count = group.monitor_count === 1 ? '1 monitor' : `${group.monitor_count} monitors`;
    lines.push(`• <b>#${group.id}</b> ${escapeHtml(group.name)} — ${count}`);
  }
  await sendReply(ctx, lines.join('\n'));
}
