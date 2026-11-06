import type { TelegramWebAppAuthResponse } from '@uptime-detective/shared';

/**
 * Telegram Mini App bootstrap.
 *
 * When the dashboard is opened from Telegram (bot menu button or `/app`), Telegram
 * appends a signed `tgWebAppData` parameter to the URL. We exchange that init data
 * for a regular JWT session before the Vue app mounts, so the router sees the user
 * as authenticated on the very first navigation.
 *
 * No external script/CDN is used: the init data is read from the URL only, so the
 * Content-Security-Policy does not need to change.
 */

/** Same localStorage key the auth store uses. */
const TOKEN_STORAGE_KEY = 'token';
const AUTH_ENDPOINT = '/api/v1/telegram/webapp/auth';
const AUTH_TIMEOUT_MS = 10_000;

/** Signed init data always carries an `auth_date` and a `hash` field. */
function looksLikeInitData(value: string): boolean {
  return /(?:^|&)auth_date=\d+/.test(value) || /(?:^|&)hash=[0-9a-f]+/i.test(value);
}

/** Collect the possible init data values found in a fragment/query string. */
function initDataCandidates(source: string): string[] {
  const candidates: string[] = [];

  // URLSearchParams performs the URL-decoding of the parameter value.
  const fromParams = new URLSearchParams(source).get('tgWebAppData');
  if (fromParams) candidates.push(fromParams);

  // Fallback for webviews that pass the fragment without outer encoding: the raw
  // value can contain unencoded "&" separators, so match up to the next Telegram
  // parameter (or the end of the string) and URL-decode it.
  const match = source.match(/(?:^|&)tgWebAppData=(.*?)(?:&tgWebApp[A-Za-z]*=|$)/);
  if (match?.[1]) {
    try {
      candidates.push(decodeURIComponent(match[1]));
    } catch (err) {
      console.warn('[Telegram Mini App] Could not URL-decode tgWebAppData:', err);
      candidates.push(match[1]);
    }
  }

  return candidates;
}

/**
 * Read the signed init data Telegram injected into the URL.
 *
 * Telegram normally puts it in the fragment (`#tgWebAppData=...`), where the value is
 * URL-encoded once. Some webviews pass it as a normal query parameter instead, so
 * both locations are checked.
 */
function extractInitData(): string | null {
  const sources = [
    window.location.hash.replace(/^#/, ''),
    window.location.search.replace(/^\?/, ''),
  ];

  for (const source of sources) {
    if (!source) continue;
    const candidates = initDataCandidates(source);
    if (candidates.length === 0) continue;
    return candidates.find(looksLikeInitData) ?? candidates[0];
  }

  return null;
}

/** Remove the init data from the address bar so it is not kept in the URL/history. */
function stripInitDataFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    let changed = false;

    if (url.hash) {
      const hashParams = new URLSearchParams(url.hash.slice(1));
      if (hashParams.has('tgWebAppData')) {
        hashParams.delete('tgWebAppData');
        const rest = hashParams.toString();
        url.hash = rest ? `#${rest}` : '';
        changed = true;
      }
    }

    if (url.searchParams.has('tgWebAppData')) {
      url.searchParams.delete('tgWebAppData');
      changed = true;
    }

    if (changed) {
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
  } catch (err) {
    console.warn('[Telegram Mini App] Could not clean the URL:', err);
  }
}

/**
 * Authenticate the current Telegram user when running as a Mini App.
 * Never throws: on any failure it logs a warning and lets the normal login flow run.
 */
export async function bootstrapTelegramWebApp(): Promise<void> {
  const initData = extractInitData();
  if (!initData) return;

  // Strip the (secret) init data from the URL even if the request below fails.
  stripInitDataFromUrl();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);

  try {
    const response = await fetch(AUTH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ init_data: initData }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      console.warn(
        '[Telegram Mini App] Sign-in rejected:',
        response.status,
        body?.error || body?.message || response.statusText,
      );
      return;
    }

    const data = (await response.json()) as TelegramWebAppAuthResponse;
    if (!data?.token) {
      console.warn('[Telegram Mini App] Sign-in response did not include a token.');
      return;
    }

    // Written before the app mounts, so the auth store and router guard pick it up.
    localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
    console.info(`[Telegram Mini App] Signed in as @${data.user?.username ?? data.telegram_user?.id}`);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      console.warn('[Telegram Mini App] Sign-in request timed out.');
    } else {
      console.warn('[Telegram Mini App] Sign-in request failed:', err);
    }
  } finally {
    clearTimeout(timeout);
  }
}
