import net from 'net';
import type { Monitor } from '@uptime-detective/shared';
import type { CheckResult } from './http.js';
import { persistCheck, handleStatusTransition, emitCheckResult } from './shared.js';

export async function performTcpCheck(monitor: Monitor): Promise<CheckResult> {
  const config = monitor.config || {};
  const target = monitor.target.replace(/^https?:\/\//, '');
  const parts = target.split('/')[0].split(':');
  const host = parts[0];
  const port = config.port || parseInt(parts[1] || '80', 10);

  const startTime = Date.now();

  return new Promise((resolve) => {
    const socket = new net.Socket();

    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ status: 0, response_time: Date.now() - startTime, status_code: null, message: `TCP connection timed out after ${monitor.timeout}ms` });
    }, monitor.timeout);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: 1, response_time: Date.now() - startTime, status_code: null, message: `Connected to ${host}:${port}` });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: 0, response_time: Date.now() - startTime, status_code: null, message: `TCP connection failed: ${err.message}` });
    });
  });
}

export async function executeTcpCheck(monitor: Monitor): Promise<void> {
  let result: CheckResult | null = null;

  for (let attempt = 0; attempt <= monitor.retries; attempt++) {
    result = await performTcpCheck(monitor);
    if (result.status === 1) break;
    if (attempt < monitor.retries) await new Promise((r) => setTimeout(r, monitor.retry_interval * 1000));
  }

  if (!result) return;
  persistCheck(monitor.id, result);
  handleStatusTransition(monitor, result);
  emitCheckResult(monitor.id, result);
}
