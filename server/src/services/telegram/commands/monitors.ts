/**
 * Monitor lifecycle commands: /info, /add (one-shot + wizard), /edit,
 * /remove (with confirmation), /pause, /resume and /restart.
 */
import type { MonitorType, MonitorWithStatus } from '@uptime-detective/shared';
import { getDb } from '../../../db/connection.js';
import { executeCheck } from '../../checker/index.js';
import { getActiveMute } from '../../mutes.js';
import {
  VALID_MONITOR_TYPES,
  createMonitor,
  deleteMonitor,
  getHeartbeatUrl,
  getMonitor,
  getMonitorWithStatus,
  listMonitorsWithStatus,
  setMonitorActive,
  updateMonitor,
  validateCreateMonitorInput,
} from '../../monitor-service.js';
import { startMonitorJob, stopMonitorJob } from '../../scheduler.js';
import { escapeHtml } from '../format.js';
import type { InlineKeyboardMarkup } from '../types.js';
import { editOrSend, firstLine, forceReply, sendReply, type CommandContext } from './context.js';
import {
  buildCreatedSummary,
  buildMonitorInfoMessage,
  buildRemoveConfirmation,
  type LastIncident,
} from './format-monitor.js';
import {
  defaultMonitorName,
  describeGroupLookupFailure,
  describeMonitorLookupFailure,
  getGroupName,
  listGroups,
  parseMonitorType,
  resolveGroupRef,
  resolveMonitorRef,
  validateTargetForType,
} from './refs.js';
import {
  clearPendingState,
  getPendingState,
  newNonce,
  setPendingState,
  type AddWizardState,
  type EditTargetState,
} from './state.js';

const ADD_WIZARD_EXPIRED =
  '⌛ This /add wizard expired. Send /add to start again.';
const REMOVE_EXPIRED =
  '⌛ This confirmation expired or is no longer valid. Send /remove again.';

function typeLabel(type: MonitorType): string {
  return type.toUpperCase();
}

function targetPrompt(type: MonitorType): string {
  switch (type) {
    case 'http':
      return 'Send the URL to check (http:// or https://).\nExample: <code>https://example.com/health</code>';
    case 'tcp':
      return 'Send the TCP target as <code>host:port</code>.\nExample: <code>db.example.com:5432</code>';
    case 'dns':
      return 'Send the DNS name to resolve.\nExample: <code>example.com</code>';
    case 'tls':
      return 'Send the TLS host (optional <code>:port</code>).\nExample: <code>example.com:443</code>';
    case 'icmp':
      return 'Send the host name or IP address to ping.\nExample: <code>example.com</code>';
    case 'heartbeat':
      return 'Send a short target label for the heartbeat monitor.\nExample: <code>backup-job</code>';
    default:
      return 'Send the monitor target.';
  }
}

function addTypeKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'HTTP', callback_data: 'add:type:http' },
        { text: 'TCP', callback_data: 'add:type:tcp' },
      ],
      [
        { text: 'DNS', callback_data: 'add:type:dns' },
        { text: 'TLS', callback_data: 'add:type:tls' },
      ],
      [
        { text: 'ICMP', callback_data: 'add:type:icmp' },
        { text: 'Heartbeat', callback_data: 'add:type:heartbeat' },
      ],
    ],
  };
}

function addGroupKeyboard(): InlineKeyboardMarkup {
  const rows = listGroups()
    .slice(0, 8)
    .map((group) => [{ text: group.name, callback_data: `add:group:${group.id}` }]);
  rows.push([{ text: '🚫 No group', callback_data: 'add:group:none' }]);
  return { inline_keyboard: rows };
}

function addIntervalKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '60 seconds', callback_data: 'add:interval:60' },
        { text: '5 minutes', callback_data: 'add:interval:300' },
      ],
      [
        { text: '15 minutes', callback_data: 'add:interval:900' },
        { text: '1 hour', callback_data: 'add:interval:3600' },
      ],
    ],
  };
}

/** Normalize a user-supplied monitor name. */
function normalizeName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, error: 'Monitor name cannot be empty.' };
  if (name.length > 100) return { ok: false, error: 'Monitor name is too long (max 100 chars).' };
  return { ok: true, name };
}

async function resolveMonitorOrReply(
  ctx: CommandContext,
  ref: string
): Promise<MonitorWithStatus | null> {
  const resolution = resolveMonitorRef(ref);
  if (!resolution.ok) {
    await sendReply(ctx, describeMonitorLookupFailure(resolution));
    return null;
  }
  return resolution.monitor;
}

// === /info ===

export async function handleInfo(ctx: CommandContext, _args: string, tokens: string[]): Promise<void> {
  if (tokens.length === 0) {
    await sendReply(ctx, '⚠️ Usage: /info &lt;monitor&gt;\nExample: /info 12, /info #12 or /info My API');
    return;
  }

  const resolution = resolveMonitorRef(tokens.join(' '));
  if (!resolution.ok) {
    await sendReply(ctx, describeMonitorLookupFailure(resolution));
    return;
  }

  // Re-read to get the freshest status right before rendering.
  const monitor = getMonitorWithStatus(resolution.monitor.id) ?? resolution.monitor;
  const groupName = monitor.group_id !== null ? getGroupName(monitor.group_id) : null;
  const lastIncident = getDb()
    .prepare(
      'SELECT started_at, resolved_at, duration_seconds FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 1'
    )
    .get(monitor.id) as LastIncident | undefined;

  await sendReply(
    ctx,
    buildMonitorInfoMessage(monitor, {
      groupName,
      lastIncident: lastIncident ?? null,
      mute: getActiveMute(monitor.id),
      heartbeatUrl: getHeartbeatUrl(monitor),
    })
  );
}

// === /add ===

export async function handleAdd(ctx: CommandContext, _args: string, tokens: string[]): Promise<void> {
  if (tokens.length === 0) {
    await startAddWizard(ctx);
    return;
  }
  await createMonitorFromArgs(ctx, tokens);
}

async function startAddWizard(ctx: CommandContext): Promise<void> {
  setPendingState(ctx.user.id, { kind: 'add', step: 'type' });
  await sendReply(
    ctx,
    '➕ <b>Add monitor</b>\n\nChoose the monitor type:',
    addTypeKeyboard()
  );
}

async function createMonitorFromArgs(ctx: CommandContext, tokens: string[]): Promise<void> {
  const type = parseMonitorType(tokens[0]);
  if (!type) {
    await sendReply(
      ctx,
      `⚠️ Unknown monitor type <code>${escapeHtml(tokens[0])}</code>. Valid types: ${VALID_MONITOR_TYPES.map(
        (value) => value.toUpperCase()
      ).join(', ')}.`
    );
    return;
  }

  if (tokens.length < 2) {
    await sendReply(
      ctx,
      '⚠️ Usage: /add &lt;type&gt; &lt;target&gt; [name] [group:&lt;id|name&gt;]\nExample: /add http https://example.com "My API" group:1'
    );
    return;
  }

  const validated = validateTargetForType(type, tokens[1]);
  if (!validated.ok) {
    await sendReply(ctx, `⚠️ ${escapeHtml(validated.error)}`);
    return;
  }

  const nameParts: string[] = [];
  let groupSpec: string | null = null;
  for (const token of tokens.slice(2)) {
    if (token.toLowerCase().startsWith('group:')) {
      groupSpec = token.slice('group:'.length);
    } else {
      nameParts.push(token);
    }
  }

  let groupId: number | null = null;
  if (groupSpec !== null) {
    const group = resolveGroupRef(groupSpec);
    if (!group.ok) {
      await sendReply(ctx, describeGroupLookupFailure(group));
      return;
    }
    groupId = group.group.id;
  }

  const rawName = nameParts.join(' ').trim() || defaultMonitorName(type, validated.target);
  const name = normalizeName(rawName);
  if (!name.ok) {
    await sendReply(ctx, `⚠️ ${escapeHtml(name.error)}`);
    return;
  }

  const inputError = validateCreateMonitorInput({
    name: name.name,
    type,
    target: validated.target,
    group_id: groupId,
  });
  if (inputError) {
    await sendReply(ctx, `⚠️ ${escapeHtml(inputError)}`);
    return;
  }

  const monitor = createMonitor({
    name: name.name,
    type,
    target: validated.target,
    group_id: groupId,
  });

  await sendReply(ctx, buildCreatedSummary(monitor, groupId !== null ? getGroupName(groupId) : null));
}

/** Plain-text step of the `/add` wizard (target or name). */
export async function continueAddWizardText(
  ctx: CommandContext,
  pending: AddWizardState,
  text: string
): Promise<void> {
  if (pending.step === 'target') {
    const type = pending.monitorType;
    if (!type) {
      clearPendingState(ctx.user.id);
      await sendReply(ctx, ADD_WIZARD_EXPIRED);
      return;
    }
    const validated = validateTargetForType(type, text);
    if (!validated.ok) {
      await sendReply(ctx, `⚠️ ${escapeHtml(validated.error)}\n\nTry again, or /cancel.`);
      return;
    }
    setPendingState(ctx.user.id, { ...pending, step: 'name', target: validated.target });
    await sendReply(
      ctx,
      `✅ Target: <code>${escapeHtml(validated.target)}</code>\n\nSend a name for the monitor (or <code>-</code> to use the target).`,
      forceReply('Monitor name')
    );
    return;
  }

  if (pending.step === 'name') {
    const type = pending.monitorType;
    const target = pending.target;
    if (!type || !target) {
      clearPendingState(ctx.user.id);
      await sendReply(ctx, ADD_WIZARD_EXPIRED);
      return;
    }
    const rawName = text.trim() === '-' ? defaultMonitorName(type, target) : text;
    const name = normalizeName(rawName);
    if (!name.ok) {
      await sendReply(ctx, `⚠️ ${escapeHtml(name.error)}\n\nTry again, or /cancel.`);
      return;
    }
    setPendingState(ctx.user.id, { ...pending, step: 'group', name: name.name });
    await sendReply(
      ctx,
      `✅ Name: <b>${escapeHtml(name.name)}</b>\n\nChoose a group for this monitor:`,
      addGroupKeyboard()
    );
    return;
  }

  await sendReply(ctx, '👆 Use the buttons above to continue, or /cancel to abort.');
}

/** `add:<step>:<value>` callback — advances the `/add` wizard. */
export async function handleAddCallback(
  ctx: CommandContext,
  step: string,
  value: string
): Promise<void> {
  const pending = getPendingState(ctx.user.id);
  if (!pending || pending.kind !== 'add') {
    await editOrSend(ctx, ADD_WIZARD_EXPIRED);
    return;
  }

  if (step === 'type') {
    const type = parseMonitorType(value);
    if (!type) {
      await editOrSend(ctx, '⚠️ Unknown monitor type.');
      return;
    }
    setPendingState(ctx.user.id, { kind: 'add', step: 'target', monitorType: type });
    await editOrSend(
      ctx,
      `➕ <b>Add monitor</b>\n\nType: <b>${typeLabel(type)}</b>\n\n${targetPrompt(type)}`,
      forceReply('Target')
    );
    return;
  }

  if (step === 'group') {
    if (pending.step !== 'group' || !pending.monitorType || !pending.target || !pending.name) {
      await editOrSend(ctx, ADD_WIZARD_EXPIRED);
      return;
    }
    let groupId: number | null = null;
    if (value !== 'none') {
      const numeric = /^\d+$/.test(value) ? Number(value) : null;
      if (numeric === null || !getGroupName(numeric)) {
        await editOrSend(ctx, '⚠️ Group not found (it may have been deleted). Send /add again.');
        return;
      }
      groupId = numeric;
    }
    setPendingState(ctx.user.id, { ...pending, step: 'interval', groupId });
    await editOrSend(
      ctx,
      `✅ Group: ${
        groupId === null ? 'none' : escapeHtml(getGroupName(groupId) ?? 'none')
      }\n\nChoose the check interval:`,
      addIntervalKeyboard()
    );
    return;
  }

  if (step === 'interval') {
    if (
      pending.step !== 'interval' ||
      !pending.monitorType ||
      !pending.target ||
      !pending.name
    ) {
      await editOrSend(ctx, ADD_WIZARD_EXPIRED);
      return;
    }
    const interval = Number(value);
    if (!Number.isInteger(interval) || interval < 10 || interval > 86400) {
      await editOrSend(ctx, '⚠️ Invalid interval.');
      return;
    }
    const groupId = pending.groupId ?? null;
    const inputError = validateCreateMonitorInput({
      name: pending.name,
      type: pending.monitorType,
      target: pending.target,
      group_id: groupId,
    });
    if (inputError) {
      clearPendingState(ctx.user.id);
      await editOrSend(ctx, `⚠️ ${escapeHtml(inputError)}`);
      return;
    }
    const monitor = createMonitor({
      name: pending.name,
      type: pending.monitorType,
      target: pending.target,
      group_id: groupId,
      interval,
    });
    clearPendingState(ctx.user.id);
    await editOrSend(ctx, buildCreatedSummary(monitor, groupId !== null ? getGroupName(groupId) : null));
    return;
  }

  await editOrSend(ctx, ADD_WIZARD_EXPIRED);
}

// === /edit ===

/**
 * `/edit` reference/new-target parsing.
 *
 * Monitor references may contain spaces (e.g. "My Cool API"), so with two or
 * more tokens the final token is the new target and the preceding tokens are
 * the reference. When the trailing token is not a plausible target for the
 * matched monitor (e.g. `/edit My Cool API`), the whole input is treated as the
 * reference and the bot prompts for the target instead.
 */
export async function handleEdit(ctx: CommandContext, _args: string, tokens: string[]): Promise<void> {
  if (tokens.length === 0) {
    await sendReply(
      ctx,
      '⚠️ Usage: /edit &lt;monitor&gt; [new target]\nExample: /edit 12 https://new.example.com or /edit "My API" https://new.example.com'
    );
    return;
  }

  if (tokens.length === 1) {
    const monitor = await resolveMonitorOrReply(ctx, tokens[0]);
    if (!monitor) return;
    await promptForEditTarget(ctx, monitor);
    return;
  }

  const lastToken = tokens[tokens.length - 1];
  const refCandidate = tokens.slice(0, -1).join(' ');
  const fullCandidate = tokens.join(' ');

  const refResolution = resolveMonitorRef(refCandidate);
  const fullResolution = resolveMonitorRef(fullCandidate);

  // `/edit My Cool API` — the whole input is a monitor name and the last word
  // is not a valid target for that monitor: ask for the target.
  if (
    fullResolution.ok &&
    !validateTargetForType(fullResolution.monitor.type, lastToken).ok
  ) {
    await promptForEditTarget(ctx, fullResolution.monitor);
    return;
  }

  // `/edit My Cool API https://new.example.com` — last token is the target.
  if (refResolution.ok) {
    await applyNewTarget(ctx, refResolution.monitor.id, refResolution.monitor.type, lastToken);
    return;
  }

  // The whole input resolved but the trailing token is also a valid target:
  // prefer asking for the target over silently updating.
  if (fullResolution.ok) {
    await promptForEditTarget(ctx, fullResolution.monitor);
    return;
  }

  await sendReply(ctx, describeMonitorLookupFailure(refResolution));
}

async function promptForEditTarget(
  ctx: CommandContext,
  monitor: MonitorWithStatus
): Promise<void> {
  setPendingState(ctx.user.id, {
    kind: 'edit',
    step: 'target',
    monitorId: monitor.id,
    monitorName: monitor.name,
    monitorType: monitor.type,
  });
  await sendReply(
    ctx,
    `✏️ Send the new target for <b>#${monitor.id} ${escapeHtml(monitor.name)}</b> (${typeLabel(
      monitor.type
    )}).\n\n${targetPrompt(monitor.type)}`,
    forceReply('New target')
  );
}

async function applyNewTarget(
  ctx: CommandContext,
  monitorId: number,
  monitorType: MonitorType,
  rawTarget: string
): Promise<boolean> {
  const validated = validateTargetForType(monitorType, rawTarget);
  if (!validated.ok) {
    await sendReply(ctx, `⚠️ ${escapeHtml(validated.error)}`);
    return false;
  }

  const previousTarget = getMonitor(monitorId)?.target ?? '?';
  const updated = updateMonitor(monitorId, { target: validated.target });
  if (!updated) {
    await sendReply(ctx, `⚠️ Monitor #${monitorId} no longer exists.`);
    return false;
  }
  await sendReply(
    ctx,
    `✅ Updated target for <b>#${updated.id} ${escapeHtml(updated.name)}</b>:\n<code>${escapeHtml(
      previousTarget
    )}</code> → <code>${escapeHtml(validated.target)}</code>`
  );
  return true;
}

/** Plain-text step of `/edit` (new target). */
export async function continueEditText(
  ctx: CommandContext,
  pending: EditTargetState,
  text: string
): Promise<void> {
  const applied = await applyNewTarget(ctx, pending.monitorId, pending.monitorType, text);
  if (applied) clearPendingState(ctx.user.id);
}

// === /remove ===

export async function handleRemove(
  ctx: CommandContext,
  _args: string,
  tokens: string[]
): Promise<void> {
  if (tokens.length === 0) {
    await sendReply(ctx, '⚠️ Usage: /remove &lt;monitor&gt;\nExample: /remove 12 or /remove "My API"');
    return;
  }

  const monitor = await resolveMonitorOrReply(ctx, tokens.join(' '));
  if (!monitor) return;

  const nonce = newNonce();
  setPendingState(ctx.user.id, {
    kind: 'remove',
    step: 'confirm',
    monitorId: monitor.id,
    monitorName: monitor.name,
    nonce,
  });
  const confirmation = buildRemoveConfirmation(monitor, nonce);
  await sendReply(ctx, confirmation.text, confirmation.reply_markup);
}

/** `rm:<monitorId>:<nonce>` callback — confirm deletion. */
export async function handleRemoveConfirm(
  ctx: CommandContext,
  monitorId: number,
  nonce: string
): Promise<void> {
  const pending = getPendingState(ctx.user.id);
  if (
    !pending ||
    pending.kind !== 'remove' ||
    pending.nonce !== nonce ||
    pending.monitorId !== monitorId
  ) {
    await editOrSend(ctx, REMOVE_EXPIRED);
    return;
  }

  clearPendingState(ctx.user.id);
  const monitor = getMonitor(monitorId);
  if (!monitor) {
    await editOrSend(ctx, `ℹ️ Monitor #${monitorId} was already deleted.`);
    return;
  }

  deleteMonitor(monitorId);
  await editOrSend(ctx, `🗑 Deleted <b>#${monitor.id} ${escapeHtml(monitor.name)}</b>.`);
}

/** `rmx:<nonce>` callback — cancel deletion. */
export async function handleRemoveCancel(ctx: CommandContext, nonce: string): Promise<void> {
  const pending = getPendingState(ctx.user.id);
  if (!pending || pending.kind !== 'remove' || pending.nonce !== nonce) {
    await editOrSend(ctx, REMOVE_EXPIRED);
    return;
  }

  clearPendingState(ctx.user.id);
  await editOrSend(ctx, '✅ Deletion cancelled. Nothing was deleted.');
}

// === /pause /resume ===

export async function handlePause(
  ctx: CommandContext,
  _args: string,
  tokens: string[]
): Promise<void> {
  if (tokens.length === 0) {
    await sendReply(ctx, '⚠️ Usage: /pause &lt;monitor&gt;\nExample: /pause 12 or /pause "My Cool API"');
    return;
  }
  const monitor = await resolveMonitorOrReply(ctx, tokens.join(' '));
  if (!monitor) return;

  const updated = setMonitorActive(monitor.id, false);
  if (!updated) {
    await sendReply(ctx, `⚠️ Monitor #${monitor.id} no longer exists.`);
    return;
  }
  await sendReply(ctx, `⏸ Paused <b>#${updated.id} ${escapeHtml(updated.name)}</b>.`);
}

export async function handleResume(
  ctx: CommandContext,
  _args: string,
  tokens: string[]
): Promise<void> {
  if (tokens.length === 0) {
    await sendReply(ctx, '⚠️ Usage: /resume &lt;monitor&gt;\nExample: /resume 12 or /resume "My Cool API"');
    return;
  }
  const monitor = await resolveMonitorOrReply(ctx, tokens.join(' '));
  if (!monitor) return;

  const updated = setMonitorActive(monitor.id, true);
  if (!updated) {
    await sendReply(ctx, `⚠️ Monitor #${monitor.id} no longer exists.`);
    return;
  }
  await sendReply(ctx, `▶️ Resumed <b>#${updated.id} ${escapeHtml(updated.name)}</b>.`);
}

// === /restart ===

export async function handleRestart(
  ctx: CommandContext,
  _args: string,
  tokens: string[]
): Promise<void> {
  let targets: MonitorWithStatus[];

  if (tokens.length === 0 || tokens[0].toLowerCase() === 'all') {
    targets = listMonitorsWithStatus({ active: true });
  } else {
    const resolution = resolveMonitorRef(tokens.join(' '));
    if (!resolution.ok) {
      await sendReply(ctx, describeMonitorLookupFailure(resolution));
      return;
    }
    targets = [resolution.monitor];
  }

  if (targets.length === 0) {
    await sendReply(ctx, 'ℹ️ No active monitors to restart.');
    return;
  }

  let restarted = 0;
  const failures: { id: number; name: string; error: string }[] = [];

  for (const monitor of targets) {
    try {
      stopMonitorJob(monitor.id);
    } catch (err) {
      console.error(`[telegram-commands] Could not stop job for monitor ${monitor.id}:`, err);
    }

    try {
      await executeCheck(monitor);
      restarted++;
    } catch (err) {
      failures.push({ id: monitor.id, name: monitor.name, error: firstLine(err) });
    }

    try {
      startMonitorJob(monitor);
    } catch (err) {
      failures.push({ id: monitor.id, name: monitor.name, error: firstLine(err) });
    }
  }

  const lines = [`🔄 Ran checks for ${restarted} monitor${restarted === 1 ? '' : 's'}.`];
  if (targets.length === 1 && !targets[0].active) {
    lines.push('ℹ️ This monitor is paused, so its scheduled checks stay disabled.');
  }
  if (failures.length > 0) {
    lines.push(
      '',
      '⚠️ Failures:',
      ...failures.map(
        (failure) => `• <b>#${failure.id}</b> ${escapeHtml(failure.name)}: ${escapeHtml(failure.error)}`
      )
    );
  }
  await sendReply(ctx, lines.join('\n'));
}
