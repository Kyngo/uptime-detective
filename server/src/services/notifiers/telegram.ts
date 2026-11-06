/**
 * Telegram notification sender.
 *
 * Uses the instance-wide single bot token (env or Settings → Telegram Bot).
 * Each notification channel only stores the destination chat id. A legacy
 * per-channel `bot_token` is still accepted as a fallback for installations
 * that have not been migrated yet.
 */
import type { NotificationPayload } from './dispatcher.js';
import { getTelegramConfig } from '../telegram/config.js';
import { escapeMarkdownV2 } from '../telegram/format.js';
import { sendMessage } from '../telegram/api.js';

export interface TelegramConfig {
  chat_id: string | number;
  message_thread_id?: number;
  /** @deprecated Legacy per-channel token, superseded by the instance bot token. */
  bot_token?: string;
}

let legacyTokenWarningShown = false;

interface EventPresentation {
  emoji: string;
  title: string;
}

function presentEvent(event: NotificationPayload['event']): EventPresentation {
  switch (event) {
    case 'down':
      return { emoji: '🔴', title: 'DOWN' };
    case 'up':
      return { emoji: '🟢', title: 'RECOVERED' };
    case 'degraded':
      return { emoji: '🟡', title: 'DEGRADED' };
    case 'tls_expiring':
      return { emoji: '🟡', title: 'TLS CERTIFICATE EXPIRING' };
    default:
      return { emoji: 'ℹ️', title: String(event).toUpperCase() };
  }
}

function buildMessage(payload: NotificationPayload): string {
  const { emoji, title } = presentEvent(payload.event);

  const lines = [
    `${emoji} *${escapeMarkdownV2(payload.monitor_name)}* is *${title}*`,
    '',
    `*Target:* \`${escapeMarkdownV2(payload.target)}\``,
    `*Type:* ${escapeMarkdownV2(payload.monitor_type.toUpperCase())}`,
  ];

  if (payload.message) {
    lines.push(`*Message:* ${escapeMarkdownV2(payload.message)}`);
  }
  if (payload.status_code) {
    lines.push(`*Status code:* ${payload.status_code}`);
  }
  if (payload.response_time !== null && payload.response_time !== undefined) {
    lines.push(`*Response:* ${payload.response_time}ms`);
  }

  lines.push('', `_${escapeMarkdownV2(payload.timestamp)}_`);

  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (appUrl && payload.monitor_id) {
    const monitorUrl = `${appUrl}/monitors/${payload.monitor_id}`.replace(/\)/g, '\\)');
    lines.push('', `[Open in Uptime Detective](${monitorUrl})`);
  }

  return lines.join('\n');
}

export async function sendTelegram(config: TelegramConfig, payload: NotificationPayload): Promise<void> {
  const instanceConfig = getTelegramConfig();
  const token = instanceConfig.bot_token || config.bot_token;

  if (!token) {
    throw new Error(
      'Telegram bot is not configured. Set the bot token in Settings → Telegram Bot (or TELEGRAM_BOT_TOKEN).'
    );
  }

  if (!instanceConfig.bot_token && config.bot_token && !legacyTokenWarningShown) {
    legacyTokenWarningShown = true;
    console.warn(
      '[notify] Telegram channel uses a legacy per-channel bot_token. Configure the single instance bot in Settings → Telegram Bot.'
    );
  }

  if (config.chat_id === undefined || config.chat_id === null || config.chat_id === '') {
    throw new Error('Telegram channel is missing chat_id');
  }

  await sendMessage(
    {
      chat_id: config.chat_id,
      text: buildMessage(payload),
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      ...(config.message_thread_id ? { message_thread_id: config.message_thread_id } : {}),
    },
    { token, baseUrl: instanceConfig.api_base_url }
  );
}
