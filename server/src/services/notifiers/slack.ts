import type { NotificationPayload } from './dispatcher.js';

export interface SlackConfig {
  webhook_url: string;
  channel?: string;
}

export async function sendSlack(config: SlackConfig, payload: NotificationPayload): Promise<void> {
  const isDown = payload.event === 'down';
  const color = isDown ? '#dc2626' : '#16a34a';
  const emoji = isDown ? ':red_circle:' : ':large_green_circle:';
  const statusText = isDown ? 'DOWN' : 'RECOVERED';

  const body = {
    channel: config.channel || undefined,
    attachments: [
      {
        color,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${emoji} *${payload.monitor_name}* is *${statusText}*`,
            },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Target:*\n${payload.target}` },
              { type: 'mrkdwn', text: `*Type:*\n${payload.monitor_type.toUpperCase()}` },
              ...(payload.message ? [{ type: 'mrkdwn', text: `*Message:*\n${payload.message}` }] : []),
              ...(payload.response_time ? [{ type: 'mrkdwn', text: `*Response:*\n${payload.response_time}ms` }] : []),
            ],
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `Uptime Detective · ${payload.timestamp}` }],
          },
        ],
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
    throw new Error(`Slack webhook failed: ${response.status}`);
  }
}
