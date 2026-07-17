import type { NotificationPayload } from './dispatcher.js';

export interface TelegramConfig {
  bot_token: string;
  chat_id: string;
}

export async function sendTelegram(config: TelegramConfig, payload: NotificationPayload): Promise<void> {
  const isDown = payload.event === 'down';
  const emoji = isDown ? '🔴' : '🟢';
  const statusText = isDown ? 'DOWN' : 'RECOVERED';

  const text = [
    `${emoji} *${escapeMarkdown(payload.monitor_name)}* is *${statusText}*`,
    '',
    `*Target:* \`${escapeMarkdown(payload.target)}\``,
    `*Type:* ${payload.monitor_type.toUpperCase()}`,
    ...(payload.message ? [`*Message:* ${escapeMarkdown(payload.message)}`] : []),
    ...(payload.response_time ? [`*Response:* ${payload.response_time}ms`] : []),
    '',
    `_${escapeMarkdown(payload.timestamp)}_`,
  ].join('\n');

  const url = `https://api.telegram.org/bot${config.bot_token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.chat_id,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Telegram API error: ${(body as any).description || response.status}`);
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
