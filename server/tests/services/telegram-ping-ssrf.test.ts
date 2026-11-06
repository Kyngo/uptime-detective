/**
 * `/ping` SSRF guard tests — non-HTTP targets must honour ALLOW_PRIVATE_IPS.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { validatePingTargetAddress } from '../../src/services/telegram/commands/ping.js';

const privateTargets = [
  { type: 'tcp' as const, target: 'localhost:8080', label: 'localhost:8080' },
  { type: 'tcp' as const, target: '127.0.0.1:3306', label: '127.0.0.1:3306' },
  { type: 'tls' as const, target: 'localhost:443', label: 'localhost:443' },
  { type: 'icmp' as const, target: '192.168.1.10', label: '192.168.1.10' },
  { type: 'dns' as const, target: 'localhost', label: 'localhost' },
];

describe('/ping address guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('blocks private/reserved targets when ALLOW_PRIVATE_IPS is not enabled', async () => {
    for (const target of privateTargets) {
      const result = await validatePingTargetAddress(target);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/private\/reserved IP/);
    }
  });

  it('allows private targets when ALLOW_PRIVATE_IPS=true', async () => {
    vi.stubEnv('ALLOW_PRIVATE_IPS', 'true');
    for (const target of privateTargets) {
      await expect(validatePingTargetAddress(target)).resolves.toEqual({ ok: true });
    }
  });

  it('leaves HTTP targets to the HTTP checker (which validates itself)', async () => {
    await expect(
      validatePingTargetAddress({ type: 'http', target: 'http://127.0.0.1', label: 'http://127.0.0.1' })
    ).resolves.toEqual({ ok: true });
  });

  it('allows public hostnames that resolve outside private ranges', async () => {
    // Use an IP literal so the assertion does not depend on network DNS.
    const result = await validatePingTargetAddress({
      type: 'tcp',
      target: '1.1.1.1:443',
      label: '1.1.1.1:443',
    });
    expect(result.ok).toBe(true);
  });
});
