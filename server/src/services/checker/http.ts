import { lookup } from 'dns/promises';
import { fetch as undiciFetch, Agent } from 'undici';
import type { Monitor, Check, CheckStatus, MonitorStatus } from '@uptime-detective/shared';
import { getDb } from '../../db/connection.js';
import { getIO } from '../../socket.js';
import { dispatchNotifications, type NotificationPayload } from '../notifiers/dispatcher.js';
import { persistCheck, handleStatusTransition as sharedHandleStatusTransition, emitCheckResult } from './shared.js';

export interface CheckResult {
  status: CheckStatus;
  response_time: number | null;
  status_code: number | null;
  message: string | null;
}

/**
 * Check if an IP address is in a private/reserved range (SSRF protection).
 */
function isPrivateIp(ip: string): boolean {
  // IPv4 private/reserved ranges
  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 127.0.0.0/8 (loopback)
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 (link-local / cloud metadata)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
  }
  // IPv6 loopback and link-local
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd')) return true;
  return false;
}

/**
 * Validate the URL scheme and resolve DNS to block SSRF against private networks.
 * Can be disabled via ALLOW_PRIVATE_IPS=true for self-hosted instances
 * that need to monitor internal services.
 */
async function validateTarget(target: string): Promise<{ valid: boolean; error?: string }> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { valid: false, error: 'Invalid URL' };
  }

  // Only allow http and https schemes
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { valid: false, error: `Blocked scheme: ${url.protocol}` };
  }

  // Skip private IP check if explicitly allowed (self-hosted monitoring)
  if (process.env.ALLOW_PRIVATE_IPS === 'true') {
    return { valid: true };
  }

  // Resolve the hostname and check the IP
  try {
    const { address } = await lookup(url.hostname);
    if (isPrivateIp(address)) {
      return { valid: false, error: `Blocked: target resolves to private IP (${address}). Set ALLOW_PRIVATE_IPS=true to monitor internal services.` };
    }
  } catch (err: any) {
    return { valid: false, error: `DNS resolution failed: ${err.message}` };
  }

  return { valid: true };
}

export async function performHttpCheck(monitor: Monitor): Promise<CheckResult> {
  const config = monitor.config || {};
  const method = config.method || 'GET';
  const acceptedCodes = parseAcceptedStatusCodes(config.accepted_status_codes || '200-299');
  const headers: Record<string, string> = config.headers || {};
  const followRedirects = config.follow_redirects !== false;
  const ignoreTls = config.ignoreTls !== false; // Default: true (ignore invalid certs)

  // SSRF protection: validate target before making request
  const validation = await validateTarget(monitor.target);
  if (!validation.valid) {
    return { status: 0, response_time: 0, status_code: null, message: validation.error || 'Blocked by SSRF protection' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), monitor.timeout);

  // Create a dispatcher that optionally ignores TLS errors
  const dispatcher = new Agent({
    connect: { rejectUnauthorized: !ignoreTls },
  });

  const startTime = Date.now();

  try {
    const fetchOptions: any = {
      method,
      headers,
      signal: controller.signal,
      redirect: followRedirects ? 'follow' : 'manual',
      dispatcher,
    };

    if (config.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchOptions.body = config.body;
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const response = await undiciFetch(monitor.target, fetchOptions);
    const responseTime = Date.now() - startTime;

    clearTimeout(timeout);

    // Check status code
    if (!acceptedCodes.includes(response.status)) {
      return {
        status: 0, // DOWN
        response_time: responseTime,
        status_code: response.status,
        message: `Unexpected status code: ${response.status}`,
      };
    }

    // Check body match regex if configured
    if (config.body_match) {
      const body = await response.text();
      const regex = new RegExp(config.body_match);
      if (!regex.test(body)) {
        return {
          status: 0, // DOWN
          response_time: responseTime,
          status_code: response.status,
          message: `Body does not match pattern: ${config.body_match}`,
        };
      }
    }

    return {
      status: 1, // UP
      response_time: responseTime,
      status_code: response.status,
      message: null,
    };
  } catch (err: any) {
    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    if (err.name === 'AbortError') {
      return {
        status: 0,
        response_time: responseTime,
        status_code: null,
        message: `Timeout after ${monitor.timeout}ms`,
      };
    }

    return {
      status: 0,
      response_time: responseTime,
      status_code: null,
      message: err.message || 'Connection failed',
    };
  } finally {
    dispatcher.close();
  }
}

/**
 * Execute a check with retries, persist result, handle status transitions.
 */
export async function executeCheck(monitor: Monitor): Promise<void> {
  let result: CheckResult | null = null;

  // Try with retries
  for (let attempt = 0; attempt <= monitor.retries; attempt++) {
    result = await performHttpCheck(monitor);

    if (result.status === 1) break; // Success, no need to retry

    if (attempt < monitor.retries) {
      // Wait before retry
      await sleep(monitor.retry_interval * 1000);
    }
  }

  if (!result) return;

  // Persist, detect transitions, emit
  persistCheck(monitor.id, result);
  sharedHandleStatusTransition(monitor, result);
  emitCheckResult(monitor.id, result);
}

function parseAcceptedStatusCodes(spec: string): number[] {
  const codes: number[] = [];
  const parts = spec.split(',').map((s) => s.trim());

  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= end; i++) {
        codes.push(i);
      }
    } else {
      codes.push(Number(part));
    }
  }

  return codes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
