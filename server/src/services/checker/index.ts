import type { Monitor } from '@uptime-detective/shared';
import { executeCheck as executeHttpCheck } from './http.js';
import { executeIcmpCheck } from './icmp.js';
import { executeDnsCheck } from './dns.js';
import { executeTlsCheck } from './tls.js';
import { executeTcpCheck } from './tcp.js';
import { executeHeartbeatCheck } from './heartbeat.js';

/**
 * Route a check to the appropriate checker based on monitor type.
 */
export async function executeCheck(monitor: Monitor): Promise<void> {
  switch (monitor.type) {
    case 'http':
      return executeHttpCheck(monitor);
    case 'icmp':
      return executeIcmpCheck(monitor);
    case 'dns':
      return executeDnsCheck(monitor);
    case 'tls':
      return executeTlsCheck(monitor);
    case 'tcp':
      return executeTcpCheck(monitor);
    case 'heartbeat':
      return executeHeartbeatCheck(monitor);
    default:
      console.error(`[checker] Unknown monitor type: ${(monitor as any).type}`);
  }
}
