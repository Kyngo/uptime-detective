/**
 * Shared reply helpers for Telegram bot command handlers.
 *
 * Every reply goes through here so HTML escaping, chunking (>4000 chars),
 * preview suppression and the "edit the callback message, fall back to a new
 * message" behaviour stay consistent across commands.
 */
import { editMessageText, sendMessage } from '../api.js';
import { escapeHtml, splitMessage } from '../format.js';
import type {
  ForceReplyMarkup,
  TelegramCallbackQuery,
  TelegramChat,
  TelegramMessage,
  TelegramReplyMarkup,
  TelegramUserInfo,
} from '../types.js';

/** Everything a command handler needs to know about the incoming update. */
export interface CommandContext {
  user: TelegramUserInfo;
  chat: TelegramChat;
  /** Present for message updates (and for callback queries with a message). */
  message?: TelegramMessage;
  callbackQuery?: TelegramCallbackQuery;
  isCallback: boolean;
}

export function createMessageContext(message: TelegramMessage): CommandContext {
  return {
    user: message.from as TelegramUserInfo,
    chat: message.chat,
    message,
    isCallback: false,
  };
}

export function createCallbackContext(query: TelegramCallbackQuery): CommandContext {
  return {
    user: query.from,
    // Inline messages have no chat; private chats use the user id as fallback.
    chat: query.message?.chat ?? { id: query.from.id, type: 'private' },
    message: query.message,
    callbackQuery: query,
    isCallback: true,
  };
}

function messageThreadId(ctx: CommandContext): number | undefined {
  if (ctx.message?.message_thread_id && ctx.message.is_topic_message) {
    return ctx.message.message_thread_id;
  }
  return undefined;
}

/**
 * Send one or more HTML messages to a chat, splitting when needed. Only the
 * first chunk carries the reply markup.
 */
export async function sendChunked(
  chatId: number | string,
  html: string,
  replyMarkup?: TelegramReplyMarkup,
  threadId?: number
): Promise<void> {
  const chunks = splitMessage(html, 4000);
  for (let index = 0; index < chunks.length; index++) {
    try {
      await sendMessage({
        chat_id: chatId,
        text: chunks[index],
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(index === 0 && replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    } catch (err) {
      // A dead chat or a Telegram outage must never kill the polling loop.
      console.error('[telegram-commands] Failed to send message:', firstLine(err));
    }
  }
}

/** Send an HTML reply to the incoming chat. */
export async function sendReply(
  ctx: CommandContext,
  html: string,
  replyMarkup?: TelegramReplyMarkup
): Promise<void> {
  await sendChunked(ctx.chat.id, html, replyMarkup, messageThreadId(ctx));
}

/**
 * Edit the message a callback query belongs to; fall back to a new message
 * when editing is impossible (message too old, not modified, no message…).
 */
export async function editOrSend(
  ctx: CommandContext,
  html: string,
  replyMarkup?: TelegramReplyMarkup
): Promise<void> {
  const message = ctx.callbackQuery?.message;
  const chunks = splitMessage(html, 4000);

  if (message) {
    try {
      await editMessageText({
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: chunks[0],
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      for (const extra of chunks.slice(1)) {
        await sendChunked(message.chat.id, extra);
      }
      return;
    } catch (err) {
      console.error('[telegram-commands] Could not edit callback message, sending a new one:', firstLine(err));
    }
  }

  await sendReply(ctx, html, replyMarkup);
}

/** Build a ForceReply markup (asks the user to answer the bot's message). */
export function forceReply(inputFieldPlaceholder?: string): ForceReplyMarkup {
  return {
    force_reply: true,
    ...(inputFieldPlaceholder ? { input_field_placeholder: inputFieldPlaceholder } : {}),
  };
}

/** First line of an error, trimmed and bounded — safe to show to a user. */
export function firstLine(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = (raw || 'Something went wrong').split('\n')[0].trim();
  if (line.length <= 180) return line;
  return `${line.slice(0, 179)}…`;
}

/** Reply with the standard `❌ <short reason>` error message. */
export async function replyError(ctx: CommandContext, err: unknown): Promise<void> {
  console.error('[telegram-commands] Handler error:', err);
  await editOrSend(ctx, `❌ ${escapeHtml(firstLine(err))}`);
}
