/**
 * Unit tests for HTTP checker: performHttpCheck, SSRF protection, status codes
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/db/connection.js', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
  })),
}));
vi.mock('../../src/socket.js', () => ({ getIO: vi.fn(() => ({ emit: vi.fn() })) }));
vi.mock('../../src/services/notifiers/dispatcher.js', () => ({
  dispatchNotifications: vi.fn(async () => {}),
}));
vi.mock('dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('undici', () => {
  const MockAgent = vi.fn(function(this: any) { this.close = vi.fn(); });
  return { fetch: vi.fn(), Agent: MockAgent };
});

import { performHttpCheck } from '../../src/services/checker/http.js';
import { lookup } from 'dns/promises';
import { fetch as undiciFetch } from 'undici';
import type { Monitor } from '@uptime-detective/shared';

function createMonitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: 1, name: 'Test Monitor', type: 'http', target: 'https://example.com',
    interval: 60, timeout: 5000, retries: 0, retry_interval: 5, config: {},
    group_id: null, tags: [], active: true, heartbeat_token: null,
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('HTTP Checker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(lookup).mockResolvedValue({ address: '93.184.216.34', family: 4 } as any);
    delete process.env.ALLOW_PRIVATE_IPS;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('SSRF protection', () => {
    it('blocks 10.x.x.x', async () => {
      vi.mocked(lookup).mockResolvedValue({ address: '10.0.0.1', family: 4 } as any);
      const result = await performHttpCheck(createMonitor());
      expect(result.status).toBe(0);
      expect(result.message).toContain('private IP');
    });

    it('blocks 172.16.x.x', async () => {
      vi.mocked(lookup).mockResolvedValue({ address: '172.16.0.1', family: 4 } as any);
      const result = await performHttpCheck(createMonitor());
      expect(result.status).toBe(0);
      expect(result.message).toContain('private IP');
    });

    it('blocks 192.168.x.x', async () => {
      vi.mocked(lookup).mockResolvedValue({ address: '192.168.1.1', family: 4 } as any);
      const result = await performHttpCheck(createMonitor());
      expect(result.status).toBe(0);
      expect(result.message).toContain('private IP');
    });

    it('blocks 127.x.x.x loopback', async () => {
      vi.mocked(lookup).mockResolvedValue({ address: '127.0.0.1', family: 4 } as any);
      const result = await performHttpCheck(createMonitor());
      expect(result.status).toBe(0);
      expect(result.message).toContain('private IP');
    });

    it('blocks 169.254.x.x (cloud metadata)', async () => {
      vi.mocked(lookup).mockResolvedValue({ address: '169.254.169.254', family: 4 } as any);
      const result = await performHttpCheck(createMonitor());
      expect(result.status).toBe(0);
      expect(result.message).toContain('private IP');
    });

    it('blocks IPv6 loopback ::1', async () => {
      vi.mocked(lookup).mockResolvedValue({ address: '::1', family: 6 } as any);
      const result = await performHttpCheck(createMonitor());
      expect(result.status).toBe(0);
      expect(result.message).toContain('private IP');
    });

    it('allows public IPs', async () => {
      vi.mocked(undiciFetch).mockResolvedValue({ status: 200, text: vi.fn(async () => '') } as any);
      const result = await performHttpCheck(createMonitor());
      expect(result.status).toBe(1);
    });

    it('allows private IPs when ALLOW_PRIVATE_IPS=true', async () => {
      process.env.ALLOW_PRIVATE_IPS = 'true';
      vi.mocked(undiciFetch).mockResolvedValue({ status: 200, text: vi.fn(async () => '') } as any);
      const result = await performHttpCheck(createMonitor({ target: 'http://192.168.1.1:8080' }));
      expect(result.status).toBe(1);
    });

    it('returns error on DNS failure', async () => {
      vi.mocked(lookup).mockRejectedValue(new Error('ENOTFOUND'));
      const result = await performHttpCheck(createMonitor());
      expect(result.status).toBe(0);
      expect(result.message).toContain('DNS resolution failed');
    });

    it('blocks non-http schemes', async () => {
      const result = await performHttpCheck(createMonitor({ target: 'ftp://example.com' }));
      expect(result.status).toBe(0);
      expect(result.message).toContain('Blocked scheme');
    });

    it('returns error for invalid URLs', async () => {
      const result = await performHttpCheck(createMonitor({ target: 'not-a-url' }));
      expect(result.status).toBe(0);
      expect(result.message).toContain('Invalid URL');
    });
  });

  describe('HTTP response handling', () => {
    it('returns UP for 200', async () => {
      vi.mocked(undiciFetch).mockResolvedValue({ status: 200, text: vi.fn(async () => 'OK') } as any);
      const result = await performHttpCheck(createMonitor());
      expect(result.status).toBe(1);
      expect(result.status_code).toBe(200);
      expect(result.message).toBeNull();
    });

    it('returns DOWN for unexpected status code', async () => {
      vi.mocked(undiciFetch).mockResolvedValue({ status: 500, text: vi.fn(async () => '') } as any);
      const result = await performHttpCheck(createMonitor());
      expect(result.status).toBe(0);
      expect(result.status_code).toBe(500);
      expect(result.message).toContain('Unexpected status code: 500');
    });

    it('accepts custom range (200-302)', async () => {
      vi.mocked(undiciFetch).mockResolvedValue({ status: 301, text: vi.fn(async () => '') } as any);
      const result = await performHttpCheck(createMonitor({ config: { accepted_status_codes: '200-302' } }));
      expect(result.status).toBe(1);
    });

    it('accepts comma-separated codes', async () => {
      vi.mocked(undiciFetch).mockResolvedValue({ status: 404, text: vi.fn(async () => '') } as any);
      const result = await performHttpCheck(createMonitor({ config: { accepted_status_codes: '200,404' } }));
      expect(result.status).toBe(1);
    });

    it('returns DOWN when body does not match pattern', async () => {
      vi.mocked(undiciFetch).mockResolvedValue({ status: 200, text: vi.fn(async () => 'Hello World') } as any);
      const result = await performHttpCheck(createMonitor({ config: { body_match: 'foobar' } }));
      expect(result.status).toBe(0);
      expect(result.message).toContain('Body does not match');
    });

    it('returns UP when body matches pattern', async () => {
      vi.mocked(undiciFetch).mockResolvedValue({ status: 200, text: vi.fn(async () => 'Hello World') } as any);
      const result = await performHttpCheck(createMonitor({ config: { body_match: 'World' } }));
      expect(result.status).toBe(1);
    });

    it('returns DOWN on timeout', async () => {
      vi.mocked(undiciFetch).mockRejectedValue(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      const result = await performHttpCheck(createMonitor({ timeout: 1000 }));
      expect(result.status).toBe(0);
      expect(result.message).toContain('Timeout');
    });

    it('returns DOWN on connection error', async () => {
      vi.mocked(undiciFetch).mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await performHttpCheck(createMonitor());
      expect(result.status).toBe(0);
      expect(result.message).toBe('ECONNREFUSED');
    });

    it('sends configured method and body', async () => {
      vi.mocked(undiciFetch).mockResolvedValue({ status: 200, text: vi.fn(async () => '') } as any);
      await performHttpCheck(createMonitor({ config: { method: 'POST', body: '{"k":"v"}' } }));
      expect(undiciFetch).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ method: 'POST', body: '{"k":"v"}' }));
    });
  });
});
