import { getDb } from '../../db/connection.js';
import { sendWebhook } from './webhook.js';
import { sendEmail } from './email.js';
import { sendSlack } from './slack.js';
import { sendDiscord } from './discord.js';
import { sendTelegram } from './telegram.js';
import type { Monitor, NotificationType } from '@uptime-detective/shared';

export interface NotificationPayload {
  event: 'down' | 'up' | 'degraded' | 'tls_expiring';
  monitor_id: number;
  monitor_name: string;
  monitor_type: string;
  target: string;
  message: string | null;
  response_time: number | null;
  status_code: number | null;
  timestamp: string;
}

/**
 * Check if a monitor is currently in a maintenance window.
 */
export function isInMaintenance(monitorId: number): boolean {
  const db = getDb();
  const now = new Date().toISOString();

  const active = db.prepare(`
    SELECT mw.id FROM maintenance_windows mw
    JOIN maintenance_monitors mm ON mm.maintenance_id = mw.id
    WHERE mm.monitor_id = ? AND mw.start_at <= ? AND mw.end_at >= ?
  `).get(monitorId, now, now);

  return !!active;
}

/**
 * Dispatch notifications for a monitor event.
 * Respects maintenance windows (suppresses notifications during maintenance).
 */
export async function dispatchNotifications(monitor: Monitor, payload: NotificationPayload): Promise<void> {
  // Suppress during maintenance
  if (isInMaintenance(monitor.id)) {
    console.log(`[notify] Suppressed for monitor ${monitor.id} (in maintenance)`);
    return;
  }

  const db = getDb();

  // Get notification channels linked to this monitor
  const channels = db.prepare(`
    SELECT n.* FROM notifications n
    JOIN monitor_notifications mn ON mn.notification_id = n.id
    WHERE mn.monitor_id = ?
  `).all(monitor.id) as any[];

  // Also get default channels (is_default = 1) if monitor has no specific channels
  let allChannels = channels;
  if (channels.length === 0) {
    const defaults = db.prepare('SELECT * FROM notifications WHERE is_default = 1').all() as any[];
    allChannels = defaults;
  }

  if (allChannels.length === 0) return;

  // Send to each channel (fire-and-forget, don't block checker)
  for (const channel of allChannels) {
    sendToChannel(channel, payload).catch((err) => {
      console.error(`[notify] Failed to send to ${channel.type}/${channel.name}: ${err.message}`);
    });
  }
}

/**
 * Send a notification to a specific channel.
 */
export async function sendToChannel(channel: any, payload: NotificationPayload): Promise<void> {
  const config = typeof channel.config === 'string' ? JSON.parse(channel.config) : channel.config;
  const type: NotificationType = channel.type;

  switch (type) {
    case 'webhook':
      return sendWebhook(config, payload);
    case 'email':
      return sendEmail(config, payload);
    case 'slack':
      return sendSlack(config, payload);
    case 'discord':
      return sendDiscord(config, payload);
    case 'telegram':
      return sendTelegram(config, payload);
    default:
      console.warn(`[notify] Unknown channel type: ${type}`);
  }
}

/**
 * Send a test notification to a channel (used by the test endpoint).
 */
export async function sendTestNotification(channelId: number): Promise<void> {
  const db = getDb();
  const channel = db.prepare('SELECT * FROM notifications WHERE id = ?').get(channelId) as any;
  if (!channel) throw new Error('Channel not found');

  const testPayload: NotificationPayload = {
    event: 'down',
    monitor_id: 0,
    monitor_name: 'Test Monitor',
    monitor_type: 'http',
    target: 'https://example.com',
    message: 'This is a test notification from Uptime Detective',
    response_time: 1234,
    status_code: 500,
    timestamp: new Date().toISOString(),
  };

  await sendToChannel(channel, testPayload);
}
