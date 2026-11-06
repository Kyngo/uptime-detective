/**
 * Access-management and identity commands: /allow, /deny, /users, /whoami and
 * the /app Mini App launcher.
 */
import {
  allowTelegramUser,
  denyTelegramUser,
  getTelegramUser,
  isTelegramUserAllowed,
  listTelegramUsers,
} from '../allowlist.js';
import { getTelegramConfig } from '../config.js';
import { escapeHtml, formatRelativeTime } from '../format.js';
import type { TelegramUserRecord } from '@uptime-detective/shared';
import type { InlineKeyboardMarkup } from '../types.js';
import { sendReply, type CommandContext } from './context.js';

const MAX_LISTED_USERS = 30;
const MAX_LISTED_PENDING = 10;

function displayName(record: TelegramUserRecord): string {
  const parts = [record.first_name, record.last_name].filter(Boolean);
  return parts.join(' ').trim();
}

function userLine(record: TelegramUserRecord, extra = ''): string {
  const id = `<code>${record.telegram_user_id}</code>`;
  const username = record.username ? ` @${escapeHtml(record.username)}` : '';
  const name = displayName(record);
  const namePart = name ? ` (${escapeHtml(name)})` : '';
  return `• ${id}${username}${namePart}${extra}`;
}

function lastSeenLabel(record: TelegramUserRecord): string {
  return record.last_seen_at ? formatRelativeTime(record.last_seen_at) : 'never';
}

/** Resolve the user targeted by an admin command: explicit ID or reply target. */
function resolveTargetUserId(ctx: CommandContext, tokens: string[]): number | null {
  if (tokens[0]) {
    const cleaned = tokens[0].replace(/^@/, '');
    if (/^\d+$/.test(cleaned)) return Number(cleaned);
    return null;
  }
  return ctx.message?.reply_to_message?.from?.id ?? null;
}

/** `/allow <telegram id>` or reply to a message with `/allow`. */
export async function handleAllow(
  ctx: CommandContext,
  _args: string,
  tokens: string[]
): Promise<void> {
  const targetId = resolveTargetUserId(ctx, tokens);
  if (targetId === null || !Number.isInteger(targetId) || targetId <= 0) {
    await sendReply(
      ctx,
      '⚠️ Usage: /allow &lt;telegram user id&gt;\nYou can also reply to a user\'s message with /allow.'
    );
    return;
  }

  const existing = getTelegramUser(targetId);
  const record = allowTelegramUser(targetId, {
    username: existing?.username ?? null,
    allowedBy: ctx.user.id,
  });

  const username = record.username ? ` (@${escapeHtml(record.username)})` : '';
  await sendReply(
    ctx,
    `✅ Allowed Telegram user <code>${record.telegram_user_id}</code>${username}.\nThey can now control this instance.`
  );
}

/** `/deny <telegram id>` — refuses self-denial. */
export async function handleDeny(
  ctx: CommandContext,
  _args: string,
  tokens: string[]
): Promise<void> {
  const targetId = resolveTargetUserId(ctx, tokens);
  if (targetId === null || !Number.isInteger(targetId) || targetId <= 0) {
    await sendReply(
      ctx,
      '⚠️ Usage: /deny &lt;telegram user id&gt;\nYou can also reply to a user\'s message with /deny.'
    );
    return;
  }

  if (targetId === ctx.user.id) {
    await sendReply(ctx, '⛔ You cannot deny yourself.');
    return;
  }

  const existing = getTelegramUser(targetId);
  if (!existing) {
    await sendReply(ctx, `ℹ️ User <code>${targetId}</code> has never talked to the bot.`);
    return;
  }

  denyTelegramUser(targetId);
  const username = existing.username ? ` (@${escapeHtml(existing.username)})` : '';
  await sendReply(ctx, `🚫 Denied Telegram user <code>${targetId}</code>${username}.`);
}

/** `/users` — allowed users with last-seen, plus pending access requests. */
export async function handleUsers(ctx: CommandContext): Promise<void> {
  const users = listTelegramUsers();
  const allowed = users.filter((user) => user.is_allowed);
  const pending = users.filter((user) => !user.is_allowed);

  const lines = ['👥 <b>Telegram users</b>', ''];

  if (allowed.length === 0) {
    lines.push('Allowed: none');
  } else {
    lines.push(`<b>Allowed (${allowed.length}):</b>`);
    for (const user of allowed.slice(0, MAX_LISTED_USERS)) {
      lines.push(userLine(user, ` — seen ${lastSeenLabel(user)}`));
    }
    if (allowed.length > MAX_LISTED_USERS) {
      lines.push(`… and ${allowed.length - MAX_LISTED_USERS} more`);
    }
  }

  lines.push('', `<b>Pending requests: ${pending.length}</b>`);
  for (const user of pending.slice(0, MAX_LISTED_PENDING)) {
    lines.push(userLine(user, ` — seen ${lastSeenLabel(user)} · /allow ${user.telegram_user_id}`));
  }
  if (pending.length > MAX_LISTED_PENDING) {
    lines.push(`… and ${pending.length - MAX_LISTED_PENDING} more`);
  }

  await sendReply(ctx, lines.join('\n'));
}

/** `/whoami` — the caller's Telegram identity and access state. */
export async function handleWhoami(ctx: CommandContext): Promise<void> {
  const allowed = isTelegramUserAllowed(ctx.user.id);
  const name = [ctx.user.first_name, ctx.user.last_name].filter(Boolean).join(' ').trim();

  const lines = [
    '🪪 <b>You</b>',
    `ID: <code>${ctx.user.id}</code>`,
    `Username: ${ctx.user.username ? `@${escapeHtml(ctx.user.username)}` : '—'}`,
    `Name: ${name ? escapeHtml(name) : '—'}`,
    `Chat: <code>${ctx.chat.id}</code> (${ctx.chat.type})`,
    `Access: ${allowed ? '✅ allowed' : '⛔ not allowed'}`,
  ];
  await sendReply(ctx, lines.join('\n'));
}

/** `/app` — send a Mini App launcher button when a web app URL is configured. */
export async function handleApp(ctx: CommandContext): Promise<void> {
  const config = getTelegramConfig();
  if (!config.webapp_url) {
    await sendReply(
      ctx,
      'ℹ️ The Mini App URL is not configured yet.\nAn admin can set it in <b>Settings → Telegram Bot</b>.'
    );
    return;
  }

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [[{ text: '🚀 Open Uptime Detective', web_app: { url: config.webapp_url } }]],
  };
  await sendReply(ctx, '📱 Open the Uptime Detective Mini App:', keyboard);
}
