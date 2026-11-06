/**
 * Minimal Telegram Bot API types used by the bot controller.
 * Only the fields this application needs are modelled.
 */

export type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel';

export interface TelegramUserInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: TelegramChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUserInfo;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUserInfo;
  sender_chat?: TelegramChat;
  chat: TelegramChat;
  date: number;
  text?: string;
  entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  message_thread_id?: number;
  is_topic_message?: boolean;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUserInfo;
  message?: TelegramMessage;
  inline_message_id?: string;
  chat_instance: string;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface ForceReplyMarkup {
  force_reply: true;
  input_field_placeholder?: string;
  selective?: boolean;
}

export interface ReplyKeyboardRemove {
  remove_keyboard: true;
  selective?: boolean;
}

export type TelegramReplyMarkup = InlineKeyboardMarkup | ForceReplyMarkup | ReplyKeyboardRemove;

/** Normalized actor information extracted from a message or callback query. */
export interface TelegramActor {
  user: TelegramUserInfo;
  chat: TelegramChat;
}
