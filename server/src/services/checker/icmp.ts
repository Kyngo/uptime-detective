import { execFile } from 'child_process';
import { platform } from 'os';
import type { Monitor } from '@uptime-detective/shared';
import type { CheckResult } from './http.js';
import { persistCheck, handleStatusTransition, emitCheckResult } from './shared.js';

// Only allow valid hostnames and IP addresses — no shell metacharacters
const VALID_HOST_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9.\-]{0,253}[a-zA-Z0-9])?$/;

export async function performIcmpCheck(monitor: Monitor): Promise<CheckResult> {
  const host = monitor.target.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];

  // Validate host to prevent command injection
  if (!VALID_HOST_REGEX.test(host)) {
    return { status: 0, response_time: 0, status_code: null, message: `Invalid hostname: ${host.slice(0, 50)}` };
  }

  const timeoutSec = Math.ceil(monitor.timeout / 1000);

  const isWindows = platform() === 'win32';
  const args = isWindows
    ? ['-n', '1', '-w', String(monitor.timeout), host]
    : ['-c', '1', '-W', String(timeoutSec), host];

  const startTime = Date.now();

  return new Promise((resolve) => {
    execFile('ping', args, { timeout: monitor.timeout + 2000 }, (error, stdout) => {
      const elapsed = Date.now() - startTime;

      if (error) {
        resolve({ status: 0, response_time: elapsed, status_code: null, message: parsePingError(error.message) });
        return;
      }

      const rtt = parseRtt(stdout);
      resolve({ status: 1, response_time: rtt ?? elapsed, status_code: null, message: null });
    });
  });
}

export async function executeIcmpCheck(monitor: Monitor): Promise<void> {
  let result: CheckResult | null = null;

  for (let attempt = 0; attempt <= monitor.retries; attempt++) {
    result = await performIcmpCheck(monitor);
    if (result.status === 1) break;
    if (attempt < monitor.retries) await new Promise((r) => setTimeout(r, monitor.retry_interval * 1000));
  }

  if (!result) return;
  persistCheck(monitor.id, result);
  handleStatusTransition(monitor, result);
  emitCheckResult(monitor.id, result);
}

function parseRtt(stdout: string): number | null {
  const match = stdout.match(/time[=<]([\d.]+)\s*ms/i);
  if (match) return Math.round(parseFloat(match[1]));
  return null;
}

function parsePingError(msg: string): string {
  if (msg.includes('Name or service not known') || msg.includes('Unknown host')) return 'DNS resolution failed';
  if (msg.includes('100% packet loss')) return '100% packet loss — host unreachable';
  if (msg.includes('timed out') || msg.includes('SIGTERM')) return 'Ping timed out';
  return `Ping failed: ${msg.split('\n')[0]}`;
}
