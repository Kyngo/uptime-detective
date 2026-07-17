import type { NotificationPayload } from './dispatcher.js';

export interface DiscordConfig {
  webhook_url: string;
}

export async function sendDiscord(config: DiscordConfig, payload: NotificationPayload): Promise<void> {
  const isDown = payload.event === 'down';
  const color = isDown ? 0xdc2626 : 0x16a34a;
  const emoji = isDown ? '🔴' : '🟢';
  const statusText = isDown ? 'DOWN' : 'RECOVERED';

  const body = {
    embeds: [
      {
        title: `${emoji} ${payload.monitor_name} is ${statusText}`,
        color,
        fields: [
          { name: 'Target', value: payload.target, inline: true },
          { name: 'Type', value: payload.monitor_type.toUpperCase(), inline: true },
          ...(payload.message ? [{ name: 'Message', value: payload.message, inline: false }] : []),
          ...(payload.response_time ? [{ name: 'Response Time', value: `${payload.response_time}ms`, inline: true }] : []),
        ],
        footer: { text: 'Uptime Detective' },
        timestamp: new Date(payload.timestamp).toISOString(),
      },
    ],
  };

  const response = await fetch(config.webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Discord webhook failed: ${response.status} ${text}`);
  }
}
