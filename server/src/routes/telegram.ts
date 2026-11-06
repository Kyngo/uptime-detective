/**
 * Telegram bot REST API.
 *
 * Mounted at `/api/v1/telegram` (see `server/src/index.ts`). All routes require
 * authentication except the public Mini App auth endpoint, which must be
 * registered before `authMiddleware`.
 *
 * The bot token is write-only over the API: every response is produced by
 * `getTelegramSettingsResponse()` / `getTelegramBotStatus()`, which only expose
 * a masked hint.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type {
  AllowTelegramUserRequest,
  UpdateTelegramSettingsRequest,
} from '@uptime-detective/shared';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import {
  getTelegramConfig,
  getTelegramSettingsResponse,
  setTelegramSetting,
  TelegramConfigError,
  TELEGRAM_SETTING_KEYS,
  updateTelegramSettings,
} from '../services/telegram/config.js';
import { getMe, sendMessage } from '../services/telegram/api.js';
import { getTelegramBotStatus, restartTelegramBot } from '../services/telegram/bot.js';
import {
  allowTelegramUser,
  denyTelegramUser,
  getTelegramUser,
  listTelegramUsers,
} from '../services/telegram/allowlist.js';
import { authenticateTelegramWebApp, TelegramWebAppAuthError } from '../services/telegram/webapp.js';

export const telegramRouter = Router();

// The Mini App auth endpoint is public (the Telegram user is authenticated by
// the signed initData), so it needs its own brute-force protection.
const webappAuthLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: { error: 'Too many Telegram Mini App authentication attempts. Try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseTelegramUserId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Coerce a settings patch body into the typed request (ignore unknown fields). */
function parseSettingsPatch(body: any): UpdateTelegramSettingsRequest {
  const patch: UpdateTelegramSettingsRequest = {};
  if (body && typeof body === 'object') {
    if (typeof body.bot_token === 'string' || body.bot_token === null) {
      patch.bot_token = body.bot_token;
    }
    if (typeof body.webapp_url === 'string' || body.webapp_url === null) {
      patch.webapp_url = body.webapp_url;
    }
    if (typeof body.enabled === 'boolean') {
      patch.enabled = body.enabled;
    }
  }
  return patch;
}

// === Public: Telegram Mini App authentication ===

// POST /api/v1/telegram/webapp/auth — PUBLIC (no authMiddleware), rate limited.
telegramRouter.post('/webapp/auth', webappAuthLimiter, async (req, res) => {
  const initData = typeof req.body?.init_data === 'string' ? req.body.init_data : '';
  if (!initData) {
    res.status(400).json({ error: 'init_data is required' });
    return;
  }

  try {
    const response = await authenticateTelegramWebApp(initData);
    res.json(response);
  } catch (error) {
    if (error instanceof TelegramWebAppAuthError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error('[telegram] Mini App authentication failed:', error);
    res.status(500).json({ error: 'Telegram authentication failed' });
  }
});

// Every route below requires a valid token.
telegramRouter.use(authMiddleware);

// === Bot configuration ===

// GET /api/v1/telegram/config
telegramRouter.get('/config', (_req, res) => {
  try {
    res.json(getTelegramSettingsResponse(getTelegramBotStatus()));
  } catch (error) {
    console.error('[telegram] Failed to read bot settings:', error);
    res.status(500).json({ error: 'Failed to read Telegram bot settings' });
  }
});

// PUT /api/v1/telegram/config — admin only.
telegramRouter.put('/config', requireAdmin, async (req, res) => {
  const patch = parseSettingsPatch(req.body);
  const config = getTelegramConfig();

  // Validate a candidate token with the Bot API before persisting it. Never
  // persist a token Telegram rejects, and never override an env-managed token.
  if (typeof patch.bot_token === 'string' && patch.bot_token.trim() !== '') {
    const candidate = patch.bot_token.trim();
    if (config.token_source === 'env') {
      res.status(400).json({
        error:
          'The bot token is managed by the TELEGRAM_BOT_TOKEN environment variable and cannot be changed here',
      });
      return;
    }
    try {
      const me = await getMe({ token: candidate, baseUrl: config.api_base_url });
      if (me?.username) {
        setTelegramSetting(TELEGRAM_SETTING_KEYS.username, me.username);
      }
    } catch (error) {
      res.status(400).json({
        error: `Invalid bot token: ${describeError(error)}. Copy the token from @BotFather and try again.`,
      });
      return;
    }
  }

  try {
    updateTelegramSettings(patch);
  } catch (error) {
    if (error instanceof TelegramConfigError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error('[telegram] Failed to update bot settings:', error);
    res.status(500).json({ error: 'Failed to update Telegram bot settings' });
    return;
  }

  // Apply the new settings to the running bot right away.
  try {
    await restartTelegramBot();
  } catch (error) {
    console.warn(`[telegram] Bot restart after settings update failed: ${describeError(error)}`);
  }

  res.json(getTelegramSettingsResponse(getTelegramBotStatus()));
});

// POST /api/v1/telegram/restart — admin only.
telegramRouter.post('/restart', requireAdmin, async (_req, res) => {
  try {
    res.json(await restartTelegramBot());
  } catch (error) {
    console.error('[telegram] Failed to restart bot:', error);
    res.status(500).json({ error: 'Failed to restart the Telegram bot' });
  }
});

// POST /api/v1/telegram/test — send a test message with the instance bot.
telegramRouter.post('/test', requireAdmin, async (req, res) => {
  const config = getTelegramConfig();
  if (!config.bot_token) {
    res.status(400).json({
      error: 'Telegram bot is not configured. Set the bot token in Telegram Bot settings first.',
    });
    return;
  }

  const rawChatId = req.body?.chat_id;
  let chatId: number | string;
  if (rawChatId !== undefined && rawChatId !== null && String(rawChatId).trim() !== '') {
    chatId = typeof rawChatId === 'number' ? rawChatId : String(rawChatId).trim();
  } else {
    const target = listTelegramUsers().find(
      (user) => user.is_allowed && user.chat_id !== null
    );
    if (!target || target.chat_id === null) {
      res.status(400).json({
        error:
          'No allowed Telegram user with a known chat id. Ask a user to send /start to the bot first, or pass a chat_id.',
      });
      return;
    }
    chatId = target.chat_id;
  }

  try {
    const sent = await sendMessage(
      {
        chat_id: chatId,
        text: '✅ Test message from Uptime Detective — the Telegram bot is configured correctly.',
        disable_web_page_preview: true,
      },
      { token: config.bot_token, baseUrl: config.api_base_url }
    );
    res.json({
      message: `Test message sent to chat ${chatId}`,
      chat_id: chatId,
      message_id: (sent as any)?.message_id ?? null,
    });
  } catch (error) {
    res.status(502).json({ error: `Failed to send test message: ${describeError(error)}` });
  }
});

// === Allow list ===

// GET /api/v1/telegram/users
telegramRouter.get('/users', (_req, res) => {
  try {
    res.json(listTelegramUsers());
  } catch (error) {
    console.error('[telegram] Failed to list users:', error);
    res.status(500).json({ error: 'Failed to list Telegram users' });
  }
});

// POST /api/v1/telegram/users — admin only: upsert a Telegram user and allow it.
telegramRouter.post('/users', requireAdmin, (req, res) => {
  const body = (req.body ?? {}) as AllowTelegramUserRequest;
  const telegramUserId = parseTelegramUserId(body.telegram_user_id);
  if (telegramUserId === null) {
    res.status(400).json({ error: 'telegram_user_id must be a positive integer' });
    return;
  }

  const record = allowTelegramUser(telegramUserId, {
    username: typeof body.username === 'string' ? body.username : null,
    allowedBy: req.user?.id ?? null,
  });

  // `is_allowed: false` is accepted so a single upsert can pre-deny a user.
  if (body.is_allowed === false) {
    denyTelegramUser(telegramUserId);
    res.json(getTelegramUser(telegramUserId));
    return;
  }

  res.json(record);
});

// PUT /api/v1/telegram/users/:id — admin only: toggle allow state.
telegramRouter.put('/users/:id', requireAdmin, (req, res) => {
  const telegramUserId = parseTelegramUserId(req.params.id);
  if (telegramUserId === null) {
    res.status(400).json({ error: 'Invalid Telegram user id' });
    return;
  }
  const isAllowed = req.body?.is_allowed;
  if (typeof isAllowed !== 'boolean') {
    res.status(400).json({ error: 'is_allowed (boolean) is required' });
    return;
  }
  if (!getTelegramUser(telegramUserId)) {
    res.status(404).json({ error: 'Telegram user not found' });
    return;
  }

  if (isAllowed) {
    allowTelegramUser(telegramUserId, { allowedBy: req.user?.id ?? null });
  } else {
    denyTelegramUser(telegramUserId);
  }
  res.json(getTelegramUser(telegramUserId));
});

// DELETE /api/v1/telegram/users/:id — admin only: deny (keep the row).
telegramRouter.delete('/users/:id', requireAdmin, (req, res) => {
  const telegramUserId = parseTelegramUserId(req.params.id);
  if (telegramUserId === null) {
    res.status(400).json({ error: 'Invalid Telegram user id' });
    return;
  }
  if (!getTelegramUser(telegramUserId)) {
    res.status(404).json({ error: 'Telegram user not found' });
    return;
  }

  denyTelegramUser(telegramUserId);
  res.json({ message: 'Telegram user denied', user: getTelegramUser(telegramUserId) });
});
