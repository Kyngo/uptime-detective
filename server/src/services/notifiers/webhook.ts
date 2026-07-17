import type { NotificationPayload } from './dispatcher.js';

export interface WebhookConfig {
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  secret?: string;
}

export async function sendWebhook(config: WebhookConfig, payload: NotificationPayload): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'UptimeDetective/1.0',
    ...(config.headers || {}),
  };

  // Add HMAC signature if secret is set
  if (config.secret) {
    const crypto = await import('crypto');
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', config.secret).update(body).digest('hex');
    headers['X-Signature-256'] = `sha256=${signature}`;
  }

  const response = await fetch(config.url, {
    method: config.method || 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
  }
}
