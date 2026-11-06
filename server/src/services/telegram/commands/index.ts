/**
 * Telegram bot command dispatcher.
 *
 * This module owns the full chat-control surface of the bot:
 *  - allow-list gating (unknown users can never execute commands),
 *  - message + callback_query routing,
 *  - the in-memory pending-action state machine,
 *  - error isolation so a failing command never kills the polling loop.
 *
 * Public interface consumed by `services/telegram/bot.ts`:
 *   BOT_COMMANDS, handleTelegramUpdate(update)
 */
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from '../types.js';
import { answerCallbackQuery } from '../api.js';
import { isTelegramUserAllowed, trackTelegramUser } from '../allowlist.js';
import { escapeHtml } from '../format.js';
import {
  createCallbackContext,
  createMessageContext,
  replyError,
  sendReply,
  type CommandContext,
} from './context.js';
import { parseCommandText, type ParsedCommand } from './refs.js';
import { clearPendingState, clearAllPendingStates, getPendingState } from './state.js';
import { handleAllow, handleApp, handleDeny, handleUsers, handleWhoami } from './admin.js';
import { handleGroups, handleHelp, handleStart, handleStatus, handleStatusCallback } from './help.js';
import {
  continueAddWizardText,
  continueEditText,
  handleAdd,
  handleAddCallback,
  handleEdit,
  handleInfo,
  handlePause,
  handleRemove,
  handleRemoveCancel,
  handleRemoveConfirm,
  handleRestart,
  handleResume,
} from './monitors.js';
import { handleMute, handleMuteCallback, handleUnmute } from './mutes.js';
import { handlePing, resetPingRateLimits } from './ping.js';

export { BOT_COMMANDS } from './catalog.js';

/** Re-send the "not authorized" notice at most once per 5 minutes per user. */
export const UNAUTHORIZED_NOTICE_INTERVAL_MS = 5 * 60_000;

const unauthorizedNotifiedAt = new Map<number, number>();

type CommandHandler = (ctx: CommandContext, args: string, tokens: string[]) => Promise<void>;

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  start: handleStart,
  help: handleHelp,
  status: handleStatus,
  info: handleInfo,
  add: handleAdd,
  edit: handleEdit,
  remove: handleRemove,
  mute: handleMute,
  unmute: handleUnmute,
  pause: handlePause,
  resume: handleResume,
  restart: handleRestart,
  ping: handlePing,
  allow: handleAllow,
  deny: handleDeny,
  users: handleUsers,
  groups: handleGroups,
  whoami: handleWhoami,
  app: handleApp,
};

/**
 * Handle one Telegram update. Never throws: all failures are caught, logged and
 * (when possible) reported to the user as `❌ <reason>`.
 */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  try {
    if (update.callback_query) {
      await handleCallbackUpdate(update.callback_query);
      return;
    }
    if (update.message?.from) {
      await handleMessageUpdate(update.message);
    }
  } catch (err) {
    console.error('[telegram-commands] Unhandled update error:', err);
  }
}

// === Message updates ===

async function handleMessageUpdate(message: TelegramMessage): Promise<void> {
  const actor = message.from as NonNullable<TelegramMessage['from']>;
  trackTelegramUser(actor, message.chat);

  const ctx = createMessageContext(message);
  const text = message.text ?? '';
  const parsed = text ? parseCommandText(text) : null;
  const allowed = isTelegramUserAllowed(actor.id);

  if (!allowed) {
    // /start is always answered so users can learn their numeric ID and how to
    // request access. Every other command/plain message is ignored (with a
    // throttled notice) and never executed.
    if (parsed?.command === 'start') {
      await handleStart(ctx);
    } else {
      await replyUnauthorizedOnce(ctx);
    }
    return;
  }

  if (!text) return;

  if (parsed) {
    await dispatchCommand(ctx, parsed);
    return;
  }

  const pending = getPendingState(actor.id);
  if (pending) {
    await consumePendingText(ctx, pending, text);
    return;
  }

  await sendReply(ctx, '🤖 I did not understand that. Use /help to see the available commands.');
}

async function replyUnauthorizedOnce(ctx: CommandContext): Promise<void> {
  const now = Date.now();
  const last = unauthorizedNotifiedAt.get(ctx.user.id);
  if (last !== undefined && now - last < UNAUTHORIZED_NOTICE_INTERVAL_MS) return;
  unauthorizedNotifiedAt.set(ctx.user.id, now);
  await sendReply(
    ctx,
    `⛔ Not authorized. Your Telegram user ID is ${ctx.user.id}. Ask an instance admin to allow you.`
  );
}

async function dispatchCommand(ctx: CommandContext, parsed: ParsedCommand): Promise<void> {
  try {
    if (parsed.command === 'cancel') {
      const hadPending = clearPendingState(ctx.user.id);
      await sendReply(ctx, hadPending ? '✅ Pending action cancelled.' : 'ℹ️ Nothing to cancel.');
      return;
    }

    // Any new command abandons a half-finished wizard/confirmation.
    clearPendingState(ctx.user.id);

    const handler = COMMAND_HANDLERS[parsed.command];
    if (!handler) {
      await sendReply(
        ctx,
        `❓ Unknown command: /${escapeHtml(parsed.command)}\nUse /help to see the available commands.`
      );
      return;
    }

    await handler(ctx, parsed.args, parsed.tokens);
  } catch (err) {
    await replyError(ctx, err);
  }
}

async function consumePendingText(
  ctx: CommandContext,
  pending: NonNullable<ReturnType<typeof getPendingState>>,
  text: string
): Promise<void> {
  try {
    switch (pending.kind) {
      case 'add':
        await continueAddWizardText(ctx, pending, text);
        return;
      case 'edit':
        await continueEditText(ctx, pending, text);
        return;
      case 'remove':
        await sendReply(
          ctx,
          '⌛ Press <b>🗑 Delete</b> or <b>Cancel</b> on the confirmation message above, or send /cancel.'
        );
        return;
    }
  } catch (err) {
    await replyError(ctx, err);
  }
}

// === Callback query updates ===

async function handleCallbackUpdate(query: TelegramCallbackQuery): Promise<void> {
  const chat = query.message?.chat;
  trackTelegramUser(query.from, chat);

  const allowed = isTelegramUserAllowed(query.from.id);

  // Telegram requires an answer for every callback query; do it first.
  try {
    await answerCallbackQuery({
      callback_query_id: query.id,
      ...(allowed ? {} : { text: 'Not authorized', show_alert: true }),
    });
  } catch (err) {
    console.error('[telegram-commands] answerCallbackQuery failed:', err);
  }

  if (!allowed) return;

  const ctx = createCallbackContext(query);
  try {
    await dispatchCallback(ctx, query.data ?? '');
  } catch (err) {
    await replyError(ctx, err);
  }
}

async function dispatchCallback(ctx: CommandContext, data: string): Promise<void> {
  const [prefix, ...rest] = data.split(':');

  switch (prefix) {
    case 'st':
      await handleStatusCallback(ctx, Number(rest[0]));
      return;
    case 'rm':
      await handleRemoveConfirm(ctx, Number(rest[0]), rest[1] ?? '');
      return;
    case 'rmx':
      await handleRemoveCancel(ctx, rest[0] ?? '');
      return;
    case 'mt':
      await handleMuteCallback(ctx, rest[0] ?? '', Number(rest[1]));
      return;
    case 'add':
      await handleAddCallback(ctx, rest[0] ?? '', rest.slice(1).join(':'));
      return;
    default:
      await replyError(ctx, new Error('Unknown or expired action.'));
  }
}

// === Test helpers ===

/** Reset all in-memory command state (used by tests). */
export function resetCommandState(): void {
  clearAllPendingStates();
  unauthorizedNotifiedAt.clear();
  resetPingRateLimits();
}
