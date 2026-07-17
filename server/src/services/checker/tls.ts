import tls from 'tls';
import type { Monitor } from '@uptime-detective/shared';
import type { CheckResult } from './http.js';
import { persistCheck, handleStatusTransition, emitCheckResult } from './shared.js';

export async function performTlsCheck(monitor: Monitor): Promise<CheckResult> {
  const config = monitor.config || {};
  const warningDays = config.tls_expiry_warning_days || 14;

  const target = monitor.target.replace(/^https?:\/\//, '');
  const [host, portStr] = target.split('/')[0].split(':');
  const port = parseInt(portStr || '443', 10);

  const startTime = Date.now();

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: CheckResult) => { if (!resolved) { resolved = true; resolve(result); } };

    const timer = setTimeout(() => {
      socket.destroy();
      done({ status: 0, response_time: Date.now() - startTime, status_code: null, message: `TLS connection timed out after ${monitor.timeout}ms` });
    }, monitor.timeout);

    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      clearTimeout(timer);
      const responseTime = Date.now() - startTime;
      const cert = socket.getPeerCertificate();

      if (!cert || !cert.valid_to) {
        socket.destroy();
        done({ status: 0, response_time: responseTime, status_code: null, message: 'No certificate returned' });
        return;
      }

      const validTo = new Date(cert.valid_to);
      const validFrom = new Date(cert.valid_from);
      const now = new Date();
      const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / 86400000);

      const authorized = socket.authorized;
      const authError = socket.authorizationError;
      socket.destroy();

      if (daysUntilExpiry < 0) {
        done({ status: 0, response_time: responseTime, status_code: null, message: `Certificate expired ${Math.abs(daysUntilExpiry)} days ago (${validTo.toISOString().split('T')[0]})` });
      } else if (now < validFrom) {
        done({ status: 0, response_time: responseTime, status_code: null, message: `Certificate not yet valid (starts ${validFrom.toISOString().split('T')[0]})` });
      } else if (daysUntilExpiry <= warningDays) {
        done({ status: 2, response_time: responseTime, status_code: null, message: `Certificate expires in ${daysUntilExpiry} days (${validTo.toISOString().split('T')[0]}) | Issuer: ${cert.issuer?.O || cert.issuer?.CN || 'Unknown'}` });
      } else {
        const chainInfo = authorized ? 'Chain valid' : `Chain issue: ${authError}`;
        done({ status: 1, response_time: responseTime, status_code: null, message: `Expires in ${daysUntilExpiry}d (${validTo.toISOString().split('T')[0]}) | Issuer: ${cert.issuer?.O || cert.issuer?.CN || 'Unknown'} | ${chainInfo}` });
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      done({ status: 0, response_time: Date.now() - startTime, status_code: null, message: `TLS connection failed: ${err.message}` });
    });
  });
}

export async function executeTlsCheck(monitor: Monitor): Promise<void> {
  let result: CheckResult | null = null;

  for (let attempt = 0; attempt <= monitor.retries; attempt++) {
    result = await performTlsCheck(monitor);
    if (result.status === 1 || result.status === 2) break;
    if (attempt < monitor.retries) await new Promise((r) => setTimeout(r, monitor.retry_interval * 1000));
  }

  if (!result) return;
  persistCheck(monitor.id, result);
  handleStatusTransition(monitor, result);
  emitCheckResult(monitor.id, result);
}
