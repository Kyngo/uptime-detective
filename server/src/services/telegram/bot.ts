/**
 * Telegram bot runtime — long polling controller.
 *
 * One instance-wide bot. The controller owns the polling loop, the update
 * offset, reconnect/backoff behaviour and the runtime status exposed through
 * the REST API (`GET /api/v1/telegram/config`, `POST /api/v1/telegram/restart`).
 *
 * Importing this module has **no side effects**: nothing starts until
 * `startTelegramBot()` is called.
 */
import type { TelegramBotStatus } from '@uptime-detective/shared';
import type { TelegramUpdate } from './types.js';
import {
  getTelegramConfig,
  setTelegramSetting,
  TELEGRAM_SETTING_KEYS,
  type ResolvedTelegramConfig,
} from './config.js';
import {
  deleteWebhook,
  getMe,
  getUpdates,
  setChatMenuButton,
  setMyCommands,
  TelegramApiError,
} from './api.js';
import { BOT_COMMANDS, handleTelegramUpdate as handleCommandUpdate } from './commands/index.js';

const POLL_TIMEOUT_SECONDS = 25;
const POLL_LIMIT = 100;
const ALLOWED_UPDATES = ['message', 'callback_query'];
/** Retry delays after consecutive polling failures, capped at the last value. */
const BACKOFF_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

interface TelegramBotState {
  running: boolean;
  started_at: string | null;
  last_error: string | null;
  updates_processed: number;
  bot_username: string | null;
  /** Next `getUpdates` offset. Kept in memory across restarts. */
  offset: number;
  /** Token the current offset belongs to (offset resets when the bot token changes). */
  offset_token: string | null;
  abortController: AbortController | null;
  loop: Promise<void> | null;
}

const state: TelegramBotState = {
  running: false,
  started_at: null,
  last_error: null,
  updates_processed: 0,
  bot_username: null,
  offset: 0,
  offset_token: null,
  abortController: null,
  loop: null,
};

function describeError(error: unknown): string {
  if (error instanceof TelegramApiError) {
    return error.description || error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Current bot status for the REST API (never contains the token). */
export function getTelegramBotStatus(): TelegramBotStatus {
  const config = getTelegramConfig();
  return {
    configured: Boolean(config.bot_token),
    enabled: config.enabled,
    running: state.running,
    bot_username: state.bot_username ?? config.bot_username,
    started_at: state.started_at,
    last_error: state.last_error,
    updates_processed: state.updates_processed,
    token_source: config.token_source,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function apiOptions(config: ResolvedTelegramConfig, signal?: AbortSignal) {
  return { token: config.bot_token ?? undefined, baseUrl: config.api_base_url, signal };
}

/**
 * Poll `getUpdates` forever (until aborted), dispatching each update to the
 * command layer. Failures are retried with exponential backoff.
 */
async function pollLoop(signal: AbortSignal, config: ResolvedTelegramConfig): Promise<void> {
  let consecutiveFailures = 0;
  let webhookConflictHandled = false;

  while (!signal.aborted) {
    try {
      const updates = await getUpdates({
        ...apiOptions(config, signal),
        offset: state.offset > 0 ? state.offset : undefined,
        timeout: POLL_TIMEOUT_SECONDS,
        limit: POLL_LIMIT,
        allowed_updates: ALLOWED_UPDATES,
      });
      if (signal.aborted) break;

      // A successful round resets the backoff and clears the last error.
      consecutiveFailures = 0;
      state.last_error = null;

      for (const update of updates) {
        if (signal.aborted) break;
        state.offset = Math.max(state.offset, update.update_id + 1);
        state.updates_processed += 1;
        try {
          await handleTelegramUpdate(update);
        } catch (error) {
          // The command layer catches its own handler errors; this is a last resort.
          console.error(
            `[telegram] Failed to handle update ${update.update_id}: ${describeError(error)}`
          );
        }
      }
    } catch (error) {
      if (signal.aborted) break;

      const message = describeError(error);
      state.last_error = message;
      const isConflict = error instanceof TelegramApiError && error.code === 409;

      if (isConflict && !webhookConflictHandled) {
        // 409 Conflict means a webhook (or another poller) owns this token.
        // Deleting the webhook once is the documented fix for switching to polling.
        webhookConflictHandled = true;
        console.warn(
          '[telegram] 409 Conflict: a webhook is configured for this bot. Deleting it and retrying long polling...'
        );
        try {
          await deleteWebhook(apiOptions(config));
          state.last_error = 'Webhook conflict resolved (deleted webhook), retrying long polling';
          consecutiveFailures = 0;
          continue;
        } catch (deleteError) {
          state.last_error =
            `409 Conflict: a webhook is configured for this bot and deleteWebhook failed ` +
            `(${describeError(deleteError)}). Delete the webhook in @BotFather or with ` +
            'deleteWebhook and make sure no other instance polls this token.';
        }
      } else if (isConflict) {
        state.last_error =
          '409 Conflict: another bot instance or a webhook is using this token. ' +
          'Stop the other instance or delete the webhook.';
      }

      consecutiveFailures += 1;
      const delay = BACKOFF_DELAYS_MS[Math.min(consecutiveFailures - 1, BACKOFF_DELAYS_MS.length - 1)];
      console.warn(`[telegram] getUpdates failed (${state.last_error}); retrying in ${delay / 1000}s`);
      await sleep(delay, signal);
    }
  }
}

/**
 * Start the bot. Safe no-op when the bot is disabled or unconfigured.
 * Registration/startup failures are stored in `status.last_error` instead of
 * throwing, so the server startup path never crashes because of Telegram.
 */
export async function startTelegramBot(): Promise<void> {
  if (state.running) return;

  const config = getTelegramConfig();
  if (!config.bot_token) {
    console.log('[telegram] Bot not configured — long polling not started');
    return;
  }
  if (!config.enabled) {
    console.log('[telegram] Bot disabled — long polling not started');
    return;
  }

  const abortController = new AbortController();
  state.abortController = abortController;
  state.running = true;
  state.started_at = new Date().toISOString();
  state.last_error = null;

  try {
    const me = await getMe(apiOptions(config));
    if (me?.username) {
      state.bot_username = me.username;
      try {
        setTelegramSetting(TELEGRAM_SETTING_KEYS.username, me.username);
      } catch (error) {
        console.warn(`[telegram] Could not persist bot username: ${describeError(error)}`);
      }
    }

    await setMyCommands(BOT_COMMANDS, apiOptions(config));

    if (config.webapp_url) {
      await setChatMenuButton(
        {
          type: 'web_app',
          text: 'Open Uptime Detective',
          web_app: { url: config.webapp_url },
        },
        apiOptions(config)
      );
      console.log(`[telegram] Web app menu button registered for ${config.webapp_url}`);
    }
  } catch (error) {
    state.last_error = describeError(error);
    state.running = false;
    state.started_at = null;
    state.abortController = null;
    console.error(`[telegram] Failed to start bot: ${state.last_error}`);
    return;
  }

  if (abortController.signal.aborted) {
    // Stopped while the initial calls were in flight.
    state.running = false;
    state.started_at = null;
    state.abortController = null;
    return;
  }

  // The offset is valid for one bot token only.
  if (state.offset_token !== config.bot_token) {
    state.offset = 0;
    state.offset_token = config.bot_token;
  }

  state.loop = pollLoop(abortController.signal, config);
  console.log(`[telegram] Bot started as @${state.bot_username ?? 'unknown'}; long polling`);
}

/** Stop long polling. Idempotent; aborts the in-flight `getUpdates` and waits for the loop. */
export async function stopTelegramBot(): Promise<void> {
  const abortController = state.abortController;
  const loop = state.loop;

  state.abortController = null;
  state.loop = null;
  state.running = false;
  state.started_at = null;

  if (abortController) abortController.abort();
  if (loop) {
    try {
      await loop;
    } catch (error) {
      // The loop handles its own errors; never throw from shutdown.
      console.warn(`[telegram] Polling loop ended with an error: ${describeError(error)}`);
    }
  }
}

/** Stop and start again with the current configuration. */
export async function restartTelegramBot(): Promise<TelegramBotStatus> {
  await stopTelegramBot();
  await startTelegramBot();
  return getTelegramBotStatus();
}

/**
 * Handle one Telegram update. Exported for tests; the polling loop calls this
 * for every update and the command layer does the actual dispatch.
 */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  try {
    await handleCommandUpdate(update);
  } catch (error) {
    console.error(`[telegram] Failed to handle update ${update?.update_id}: ${describeError(error)}`);
  }
}
