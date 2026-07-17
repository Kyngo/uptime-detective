/**
 * Unit tests for notification dispatcher
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockAll = vi.fn();
vi.mock('../../src/db/connection.js', () => ({
  getDb: vi.fn(() => ({ prepare: vi.fn(() => ({ get: mockGet, all: mockAll })) })),
}));
vi.mock('../../src/services/notifiers/webhook.js', () => ({ sendWebhook: vi.fn(async () => {}) }));
vi.mock('../../src/services/notifiers/email.js', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('../../src/services/notifiers/slack.js', () => ({ sendSlack: vi.fn(async () => {}) }));
vi.mock('../../src/services/notifiers/discord.js', () => ({ sendDiscord: vi.fn(async () => {}) }));
vi.mock('../../src/services/notifiers/telegram.js', () => ({ sendTelegram: vi.fn(async () => {}) }));

import { isInMaintenance, dispatchNotifications, sendToChannel, type NotificationPayload } from '../../src/services/notifiers/dispatcher.js';
import { sendWebhook } from '../../src/services/notifiers/webhook.js';
import { sendEmail } from '../../src/services/notifiers/email.js';
import { sendSlack } from '../../src/services/notifiers/slack.js';
import { sendDiscord } from '../../src/services/notifiers/discord.js';
import { sendTelegram } from '../../src/services/notifiers/telegram.js';
import type { Monitor } from '@uptime-detective/shared';

const monitor: Monitor = {
  id: 1, name: 'Test', type: 'http', target: 'https://example.com',
  interval: 60, timeout: 5000, retries: 0, retry_interval: 5, config: {},
  group_id: null, tags: [], active: true, heartbeat_token: null,
  created_at: '', updated_at: '',
};

const payload: NotificationPayload = {
  event: 'down', monitor_id: 1, monitor_name: 'Test', monitor_type: 'http',
  target: 'https://example.com', message: 'Error', response_time: 100,
  status_code: null, timestamp: '2024-01-01T00:00:00Z',
};

describe('Notification Dispatcher', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('isInMaintenance', () => {
    it('returns true when in maintenance', () => {
      mockGet.mockReturnValue({ id: 1 });
      expect(isInMaintenance(1)).toBe(true);
    });
    it('returns false when not in maintenance', () => {
      mockGet.mockReturnValue(undefined);
      expect(isInMaintenance(1)).toBe(false);
    });
  });

  describe('dispatchNotifications', () => {
    it('suppresses during maintenance', async () => {
      mockGet.mockReturnValue({ id: 1 });
      await dispatchNotifications(monitor, payload);
      expect(sendWebhook).not.toHaveBeenCalled();
    });

    it('sends to linked channels', async () => {
      mockGet.mockReturnValueOnce(undefined);
      mockAll.mockReturnValueOnce([
        { id: 1, type: 'slack', config: '{"webhook_url":"https://hooks.slack.com/x"}' },
      ]);
      await dispatchNotifications(monitor, payload);
      expect(sendSlack).toHaveBeenCalled();
    });

    it('falls back to default channels', async () => {
      mockGet.mockReturnValueOnce(undefined);
      mockAll.mockReturnValueOnce([]).mockReturnValueOnce([
        { id: 2, type: 'email', config: '{"to":"a@b.com"}', is_default: 1 },
      ]);
      await dispatchNotifications(monitor, payload);
      expect(sendEmail).toHaveBeenCalled();
    });

    it('does nothing without channels', async () => {
      mockGet.mockReturnValueOnce(undefined);
      mockAll.mockReturnValueOnce([]).mockReturnValueOnce([]);
      await dispatchNotifications(monitor, payload);
      expect(sendWebhook).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('sendToChannel', () => {
    it('webhook', async () => {
      await sendToChannel({ type: 'webhook', config: '{"url":"http://x"}' }, payload);
      expect(sendWebhook).toHaveBeenCalledWith({ url: 'http://x' }, payload);
    });
    it('email', async () => {
      await sendToChannel({ type: 'email', config: '{"to":"a@b.com"}' }, payload);
      expect(sendEmail).toHaveBeenCalledWith({ to: 'a@b.com' }, payload);
    });
    it('slack', async () => {
      await sendToChannel({ type: 'slack', config: '{"webhook_url":"http://s"}' }, payload);
      expect(sendSlack).toHaveBeenCalled();
    });
    it('discord', async () => {
      await sendToChannel({ type: 'discord', config: '{"webhook_url":"http://d"}' }, payload);
      expect(sendDiscord).toHaveBeenCalled();
    });
    it('telegram', async () => {
      await sendToChannel({ type: 'telegram', config: '{"bot_token":"t","chat_id":"c"}' }, payload);
      expect(sendTelegram).toHaveBeenCalled();
    });
    it('handles pre-parsed config object', async () => {
      await sendToChannel({ type: 'webhook', config: { url: 'http://x' } }, payload);
      expect(sendWebhook).toHaveBeenCalledWith({ url: 'http://x' }, payload);
    });
    it('warns on unknown type', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await sendToChannel({ type: 'sms', config: '{}' }, payload);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Unknown'));
      spy.mockRestore();
    });
  });
});
