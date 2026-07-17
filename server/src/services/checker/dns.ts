import { Resolver } from 'dns/promises';
import type { Monitor } from '@uptime-detective/shared';
import type { CheckResult } from './http.js';
import { persistCheck, handleStatusTransition, emitCheckResult } from './shared.js';

export async function performDnsCheck(monitor: Monitor): Promise<CheckResult> {
  const config = monitor.config || {};
  const recordType = config.dns_record_type || 'A';
  const expectedValue = config.dns_expected_value || null;
  const host = monitor.target.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];

  const resolver = new Resolver();
  resolver.setServers(config.dns_resolver ? [config.dns_resolver] : ['8.8.8.8', '1.1.1.1']);

  const startTime = Date.now();

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`DNS timeout after ${monitor.timeout}ms`)), monitor.timeout)
    );
    const records = await Promise.race([resolveDns(resolver, host, recordType), timeoutPromise]);
    const responseTime = Date.now() - startTime;
    const resolved = flattenRecords(records);

    if (expectedValue) {
      const matches = resolved.some((r) => r === expectedValue || r.includes(expectedValue));
      if (!matches) return { status: 0, response_time: responseTime, status_code: null, message: `Expected "${expectedValue}" but got: ${resolved.join(', ')}` };
    }

    return { status: 1, response_time: responseTime, status_code: null, message: `Resolved: ${resolved.join(', ')}` };
  } catch (err: any) {
    return { status: 0, response_time: Date.now() - startTime, status_code: null, message: err.message || 'DNS resolution failed' };
  }
}

export async function executeDnsCheck(monitor: Monitor): Promise<void> {
  let result: CheckResult | null = null;

  for (let attempt = 0; attempt <= monitor.retries; attempt++) {
    result = await performDnsCheck(monitor);
    if (result.status === 1) break;
    if (attempt < monitor.retries) await new Promise((r) => setTimeout(r, monitor.retry_interval * 1000));
  }

  if (!result) return;
  persistCheck(monitor.id, result);
  handleStatusTransition(monitor, result);
  emitCheckResult(monitor.id, result);
}

async function resolveDns(resolver: Resolver, host: string, recordType: string): Promise<any> {
  switch (recordType.toUpperCase()) {
    case 'A': return resolver.resolve4(host);
    case 'AAAA': return resolver.resolve6(host);
    case 'CNAME': return resolver.resolveCname(host);
    case 'MX': return resolver.resolveMx(host);
    case 'TXT': return resolver.resolveTxt(host);
    case 'NS': return resolver.resolveNs(host);
    case 'SOA': return [await resolver.resolveSoa(host)];
    case 'SRV': return resolver.resolveSrv(host);
    default: return resolver.resolve(host, recordType);
  }
}

function flattenRecords(records: any[]): string[] {
  return records.map((r) => {
    if (typeof r === 'string') return r;
    if (r.exchange) return `${r.priority} ${r.exchange}`;
    if (r.nsname) return `${r.nsname} ${r.hostmaster}`;
    if (Array.isArray(r)) return r.join('');
    return JSON.stringify(r);
  });
}
