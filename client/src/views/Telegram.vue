<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useApi } from '../composables/useApi.js';
import type {
  TelegramBotSettingsResponse,
  TelegramBotStatus,
  TelegramUserRecord,
  UpdateTelegramSettingsRequest,
} from '@uptime-detective/shared';

const api = useApi();

interface CommandRef {
  command: string;
  description: string;
}

// Kept in sync with .team spec §7 (BOT_COMMANDS on the server).
const COMMANDS: CommandRef[] = [
  { command: '/start', description: 'Welcome message with your Telegram ID and access state.' },
  { command: '/help', description: 'List every available command.' },
  { command: '/status', description: 'Overview of all monitors with status, response time and 24h uptime (paginated).' },
  { command: '/info <ref>', description: 'Full details for one monitor: target, checks, uptime, last incident, mute state.' },
  { command: '/add', description: 'Guided wizard to create a new monitor.' },
  { command: '/add <type> <target> [name]', description: 'Create a monitor in one message.' },
  { command: '/edit <ref> [new target]', description: 'Change the target of a monitor.' },
  { command: '/remove <ref>', description: 'Delete a monitor after an inline confirmation.' },
  { command: '/mute <ref|all> [duration]', description: 'Silence notifications for a while (15m, 1h, 4h, 12h, 1d, 1w).' },
  { command: '/unmute <ref|all>', description: 'Remove an active mute.' },
  { command: '/pause <ref>', description: 'Pause checks for a monitor.' },
  { command: '/resume <ref>', description: 'Resume checks for a monitor.' },
  { command: '/restart [ref|all]', description: 'Run checks again immediately without waiting for the interval.' },
  { command: '/ping <target>', description: 'One-off check (http, tcp, tls, dns, icmp). Nothing is stored.' },
  { command: '/allow <id>', description: 'Allow a Telegram user (or reply with /allow to allow that sender).' },
  { command: '/deny <id>', description: 'Deny a Telegram user. You cannot deny yourself.' },
  { command: '/users', description: 'List allowed users and the number of pending users.' },
  { command: '/groups', description: 'List monitor groups with their monitor count.' },
  { command: '/whoami', description: 'Show your Telegram account details.' },
  { command: '/app', description: 'Open the dashboard Mini App (when a web app URL is configured).' },
  { command: '/cancel', description: 'Cancel a pending wizard, edit or confirmation.' },
];

const loading = ref(true);
const loadError = ref('');
const currentUser = ref<{ username: string; role: string } | null>(null);
const isAdmin = computed(() => currentUser.value === null || currentUser.value.role === 'admin');

const config = ref<TelegramBotSettingsResponse | null>(null);
const form = ref({ enabled: false, bot_token: '', webapp_url: '' });
const users = ref<TelegramUserRecord[]>([]);
const usersLoading = ref(false);
const busyUserId = ref<number | null>(null);
const addUserId = ref('');
const addingUser = ref(false);
const testChatId = ref('');
const testSending = ref(false);
const testResult = ref<{ kind: 'success' | 'error'; text: string } | null>(null);
const saving = ref(false);
const restarting = ref(false);
const message = ref<{ kind: 'success' | 'error'; text: string } | null>(null);

let flashTimer: ReturnType<typeof setTimeout> | undefined;

const status = computed<TelegramBotStatus | null>(() => config.value?.status ?? null);
const tokenManagedByEnv = computed(() => config.value?.token_source === 'env');
const savedWebappUrl = computed(() => config.value?.webapp_url ?? '');
const tokenPlaceholder = computed(() =>
  config.value?.bot_token_hint ? `Current: ${config.value.bot_token_hint}` : 'Not configured — paste the token from @BotFather',
);

const statusLabel = computed(() => {
  const s = status.value;
  if (!s) return 'Loading…';
  if (s.running) return s.bot_username ? `Connected as @${s.bot_username}` : 'Connected';
  return 'Stopped';
});

const statusDotClass = computed(() => {
  const s = status.value;
  if (s?.running) return 'bg-green-500';
  if (s?.enabled) return 'bg-amber-500';
  return 'bg-gray-400';
});

const statusBannerClass = computed(() => {
  const s = status.value;
  if (s?.running) {
    return 'bg-green-50 border border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-800 dark:text-green-300';
  }
  if (s?.enabled) {
    return 'bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-300';
  }
  return 'bg-gray-50 border border-gray-200 text-gray-700 dark:bg-gray-700/40 dark:border-gray-600 dark:text-gray-300';
});

const tokenSourceLabel = computed(() => {
  switch (config.value?.token_source) {
    case 'env': return 'Environment (TELEGRAM_BOT_TOKEN)';
    case 'settings': return 'Saved in settings';
    default: return 'Not configured';
  }
});

const pendingCount = computed(() => users.value.filter((u) => !u.is_allowed).length);

const sortedUsers = computed(() => {
  return [...users.value].sort((a, b) => {
    if (a.is_allowed !== b.is_allowed) return a.is_allowed ? 1 : -1;
    const aSeen = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
    const bSeen = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
    if (aSeen !== bSeen) return bSeen - aSeen;
    return a.telegram_user_id - b.telegram_user_id;
  });
});

function flash(kind: 'success' | 'error', text: string): void {
  message.value = { kind, text };
  if (flashTimer) clearTimeout(flashTimer);
  if (kind === 'success') {
    flashTimer = setTimeout(() => { message.value = null; }, 4000);
  }
}

function applyConfig(next: TelegramBotSettingsResponse): void {
  config.value = next;
  form.value = {
    enabled: next.enabled,
    bot_token: '',
    webapp_url: next.webapp_url ?? '',
  };
}

function upsertUser(record: TelegramUserRecord): void {
  const exists = users.value.some((u) => u.telegram_user_id === record.telegram_user_id);
  users.value = exists
    ? users.value.map((u) => (u.telegram_user_id === record.telegram_user_id ? record : u))
    : [...users.value, record];
}

function displayName(user: TelegramUserRecord): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return name || '—';
}

function displayHandle(user: TelegramUserRecord): string {
  return user.username ? `@${user.username}` : '—';
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function loadConfig(): Promise<void> {
  const next = await api.get<TelegramBotSettingsResponse>('/api/v1/telegram/config');
  applyConfig(next);
}

async function loadUsers(): Promise<void> {
  usersLoading.value = true;
  try {
    users.value = await api.get<TelegramUserRecord[]>('/api/v1/telegram/users');
  } catch (err: any) {
    flash('error', err?.message || 'Could not load the allow list.');
  } finally {
    usersLoading.value = false;
  }
}

async function loadAll(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const me = await api.get<{ username: string; role: string }>('/api/v1/auth/me').catch(() => null);
    currentUser.value = me;
    await Promise.all([loadConfig(), loadUsers()]);
  } catch (err: any) {
    loadError.value = err?.message || 'Could not load the Telegram bot settings.';
  } finally {
    loading.value = false;
  }
}

async function saveSettings(): Promise<void> {
  if (!isAdmin.value) return;
  saving.value = true;
  try {
    const payload: UpdateTelegramSettingsRequest = {
      enabled: form.value.enabled,
      webapp_url: form.value.webapp_url.trim() || null,
    };
    // A token managed by the environment cannot be changed from the UI.
    if (!tokenManagedByEnv.value && form.value.bot_token.trim()) {
      payload.bot_token = form.value.bot_token.trim();
    }
    const next = await api.put<TelegramBotSettingsResponse>('/api/v1/telegram/config', payload);
    applyConfig(next);
    flash('success', 'Bot settings saved.');
  } catch (err: any) {
    flash('error', err?.message || 'Could not save the bot settings.');
  } finally {
    saving.value = false;
  }
}

async function restartBot(): Promise<void> {
  if (!isAdmin.value) return;
  restarting.value = true;
  try {
    // The restart response is the fresh bot status: apply it so the status line,
    // bot username and last_error below reflect the restart immediately.
    const nextStatus = await api.post<TelegramBotStatus>('/api/v1/telegram/restart', {});
    if (config.value) {
      config.value.status = nextStatus;
      config.value.bot_username = nextStatus.bot_username;
    }
    if (nextStatus.running) {
      flash('success', nextStatus.bot_username ? `Bot running as @${nextStatus.bot_username}.` : 'Bot restarted and is running.');
    } else {
      flash('error', nextStatus.last_error ? `Bot is not running: ${nextStatus.last_error}` : 'Bot restarted but is not running. Check the token and enabled state.');
    }
  } catch (err: any) {
    flash('error', err?.message || 'Could not restart the bot.');
  } finally {
    restarting.value = false;
  }
}

async function setUserAllowed(user: TelegramUserRecord, allowed: boolean): Promise<void> {
  if (!isAdmin.value || busyUserId.value !== null) return;
  busyUserId.value = user.telegram_user_id;
  try {
    const updated = await api.put<TelegramUserRecord>(`/api/v1/telegram/users/${user.telegram_user_id}`, { is_allowed: allowed });
    upsertUser(updated);
    flash('success', allowed ? `User ${user.telegram_user_id} allowed.` : `User ${user.telegram_user_id} denied.`);
  } catch (err: any) {
    flash('error', err?.message || 'Could not update that user.');
  } finally {
    busyUserId.value = null;
  }
}

async function denyUser(user: TelegramUserRecord): Promise<void> {
  if (!isAdmin.value || busyUserId.value !== null) return;
  if (!confirm(`Deny ${displayHandle(user)} (ID ${user.telegram_user_id})? They will no longer be able to use the bot.`)) return;
  busyUserId.value = user.telegram_user_id;
  try {
    const result = await api.del<{ message?: string; user?: TelegramUserRecord }>(`/api/v1/telegram/users/${user.telegram_user_id}`);
    upsertUser(result?.user ?? { ...user, is_allowed: false });
    flash('success', `User ${user.telegram_user_id} denied.`);
  } catch (err: any) {
    flash('error', err?.message || 'Could not deny that user.');
  } finally {
    busyUserId.value = null;
  }
}

async function addUserById(): Promise<void> {
  if (!isAdmin.value) return;
  const raw = addUserId.value.trim();
  if (!/^\d+$/.test(raw)) {
    flash('error', 'Enter a numeric Telegram user ID (for example 123456789).');
    return;
  }
  const telegramUserId = Number(raw);
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) {
    flash('error', 'That Telegram user ID is not valid.');
    return;
  }
  addingUser.value = true;
  try {
    const created = await api.post<TelegramUserRecord>('/api/v1/telegram/users', {
      telegram_user_id: telegramUserId,
      is_allowed: true,
    });
    upsertUser(created);
    addUserId.value = '';
    flash('success', `User ${telegramUserId} is now allowed.`);
  } catch (err: any) {
    flash('error', err?.message || 'Could not allow that user.');
  } finally {
    addingUser.value = false;
  }
}

async function sendTestMessage(): Promise<void> {
  if (!isAdmin.value) return;
  testSending.value = true;
  testResult.value = null;
  try {
    const payload: { chat_id?: string } = {};
    const chatId = testChatId.value.trim();
    if (chatId) payload.chat_id = chatId;
    const result = await api.post<{ message?: string }>('/api/v1/telegram/test', payload);
    testResult.value = { kind: 'success', text: result?.message || 'Test message sent.' };
  } catch (err: any) {
    testResult.value = { kind: 'error', text: err?.message || 'Could not send the test message.' };
  } finally {
    testSending.value = false;
  }
}

function toggleEnabled(): void {
  if (!isAdmin.value) return;
  form.value.enabled = !form.value.enabled;
}

onMounted(loadAll);
</script>

<template>
  <div class="max-w-5xl">
    <!-- Header -->
    <div class="flex flex-wrap items-start justify-between gap-3 mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">✈️ Telegram Bot</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
          One bot controls this instance and sends Telegram notifications.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span
          v-if="config"
          class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
        >
          <span class="w-2 h-2 rounded-full" :class="statusDotClass"></span>
          {{ statusLabel }}
        </span>
        <button
          @click="loadAll"
          :disabled="loading"
          class="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          ↻ Refresh
        </button>
      </div>
    </div>

    <!-- Flash message -->
    <div
      v-if="message"
      class="mb-4 p-3 rounded-lg text-sm"
      :class="message.kind === 'success'
        ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
        : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'"
    >
      {{ message.kind === 'success' ? '✓' : '✗' }} {{ message.text }}
    </div>

    <!-- Read-only notice for non-admins -->
    <div
      v-if="!loading && !loadError && !isAdmin"
      class="mb-4 p-3 rounded-lg text-sm bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-300"
    >
      Signed in as <span class="font-medium">{{ currentUser?.username }}</span>. Only admins can change the Telegram bot configuration — you can view the current state below.
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-500">Loading…</div>

    <div v-else-if="loadError" class="bg-white dark:bg-gray-800 rounded-lg border border-red-200 dark:border-red-800 p-6 text-center">
      <p class="text-sm text-red-600 dark:text-red-400">{{ loadError }}</p>
      <button @click="loadAll" class="mt-3 px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700">Retry</button>
    </div>

    <template v-else>
      <!-- Bot configuration -->
      <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 sm:p-6 mb-6">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h2 class="font-semibold text-gray-900 dark:text-white">Bot configuration</h2>
          <span class="text-xs text-gray-500 dark:text-gray-400">Token source: {{ tokenSourceLabel }}</span>
        </div>

        <!-- Runtime status -->
        <div class="rounded-lg p-3 mb-5 text-sm" :class="statusBannerClass">
          <p class="font-medium">{{ statusLabel }}</p>
          <p v-if="status?.last_error" class="mt-1 text-red-600 dark:text-red-400 break-words">
            Last error: <code class="text-xs">{{ status.last_error }}</code>
          </p>
          <p v-else-if="!status?.configured" class="mt-1">
            No token configured yet. Paste a bot token from @BotFather below and enable the bot.
          </p>
          <p v-else-if="!status?.enabled" class="mt-1">
            The bot is disabled. Enable it below and save to start it.
          </p>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <!-- Enabled -->
          <div class="sm:col-span-2">
            <label class="flex items-start gap-3 cursor-pointer select-none">
              <button
                type="button"
                role="switch"
                :aria-checked="form.enabled"
                :disabled="!isAdmin || saving || tokenManagedByEnv"
                @click="toggleEnabled"
                class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                :class="form.enabled ? 'bg-primary-600' : 'bg-gray-300 dark:bg-gray-600'"
              >
                <span
                  class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                  :class="form.enabled ? 'translate-x-6' : 'translate-x-1'"
                />
              </button>
              <span>
                <span class="block text-sm font-medium text-gray-900 dark:text-white">Enable bot control (chat commands)</span>
                <span class="block text-xs text-gray-500 dark:text-gray-400">
                  When disabled, the bot stops polling Telegram for chat commands. Alert notifications still use the configured bot token.
                </span>
                <span v-if="tokenManagedByEnv" class="block text-xs text-gray-500 dark:text-gray-400 mt-1">
                  🔒 Controlled by the <code>TELEGRAM_BOT_ENABLED</code> environment variable.
                </span>
              </span>
            </label>
          </div>

          <!-- Bot token -->
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Bot token</label>
            <input
              v-model="form.bot_token"
              type="password"
              autocomplete="new-password"
              :disabled="!isAdmin || saving || tokenManagedByEnv"
              :placeholder="tokenPlaceholder"
              class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-60 disabled:cursor-not-allowed"
            />
            <p v-if="tokenManagedByEnv" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              🔒 Managed by environment (<code>TELEGRAM_BOT_TOKEN</code>). It cannot be changed here.
            </p>
            <p v-else class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Leave blank to keep the current token. The full token is never shown.
            </p>
          </div>

          <!-- Web app URL -->
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Mini App web app URL <span class="text-gray-400 font-normal">(optional)</span></label>
            <input
              v-model="form.webapp_url"
              type="url"
              :disabled="!isAdmin || saving"
              placeholder="https://uptime.example.com/"
              class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-60 disabled:cursor-not-allowed"
            />
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Public HTTPS URL of this dashboard. When set, the bot registers an “Open Uptime Detective” menu button on restart.
            </p>
          </div>
        </div>

        <!-- Status details -->
        <dl v-if="status" class="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div class="p-3 rounded-lg bg-gray-50 dark:bg-gray-700/40">
            <dt class="text-xs text-gray-500 dark:text-gray-400">Running</dt>
            <dd class="font-medium text-gray-900 dark:text-white">{{ status.running ? 'Yes' : 'No' }}</dd>
          </div>
          <div class="p-3 rounded-lg bg-gray-50 dark:bg-gray-700/40">
            <dt class="text-xs text-gray-500 dark:text-gray-400">Bot username</dt>
            <dd class="font-medium text-gray-900 dark:text-white">{{ status.bot_username ? `@${status.bot_username}` : '—' }}</dd>
          </div>
          <div class="p-3 rounded-lg bg-gray-50 dark:bg-gray-700/40">
            <dt class="text-xs text-gray-500 dark:text-gray-400">Updates processed</dt>
            <dd class="font-medium text-gray-900 dark:text-white">{{ status.updates_processed }}</dd>
          </div>
          <div class="p-3 rounded-lg bg-gray-50 dark:bg-gray-700/40">
            <dt class="text-xs text-gray-500 dark:text-gray-400">Started at</dt>
            <dd class="font-medium text-gray-900 dark:text-white">{{ formatDateTime(status.started_at) }}</dd>
          </div>
          <div class="p-3 rounded-lg bg-gray-50 dark:bg-gray-700/40">
            <dt class="text-xs text-gray-500 dark:text-gray-400">Token configured</dt>
            <dd class="font-medium text-gray-900 dark:text-white">{{ status.configured ? 'Yes' : 'No' }}</dd>
          </div>
          <div class="p-3 rounded-lg bg-gray-50 dark:bg-gray-700/40">
            <dt class="text-xs text-gray-500 dark:text-gray-400">Telegram API</dt>
            <dd class="font-medium text-gray-900 dark:text-white text-xs break-all">{{ config?.api_base_url }}</dd>
          </div>
        </dl>

        <div class="mt-5 flex flex-wrap items-center gap-2">
          <button
            @click="saveSettings"
            :disabled="!isAdmin || saving || restarting"
            class="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ saving ? 'Saving…' : 'Save settings' }}
          </button>
          <button
            @click="restartBot"
            :disabled="!isAdmin || saving || restarting"
            class="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ restarting ? 'Restarting…' : 'Validate & restart' }}
          </button>
          <span class="text-xs text-gray-500 dark:text-gray-400">Saving a token or web app URL restarts the bot automatically.</span>
        </div>

        <p class="mt-4 text-xs text-gray-500 dark:text-gray-400">
          💡 Create a bot with
          <a href="https://core.telegram.org/bots/features#botfather" target="_blank" rel="noopener noreferrer" class="text-primary-600 dark:text-primary-400 hover:underline">@BotFather</a>
          and paste its token here. Full setup guide: <code>docs/telegram.md</code>.
        </p>
      </div>

      <!-- Allow list -->
      <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 sm:p-6 mb-6">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h2 class="font-semibold text-gray-900 dark:text-white">Allowed Telegram users</h2>
          <span class="text-xs text-gray-500 dark:text-gray-400">
            {{ users.length }} known · {{ pendingCount }} pending
          </span>
        </div>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Allowed users are effectively instance administrators: they can run every bot command. Users must send
          <code class="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-xs">/start</code> to the bot first — their numeric ID then appears
          here as <span class="font-medium text-amber-600 dark:text-amber-400">Pending</span>.
        </p>

        <!-- Add by ID -->
        <form @submit.prevent="addUserById" class="flex flex-wrap items-end gap-2 mb-4">
          <div class="flex-1 min-w-[12rem]">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Add by Telegram user ID</label>
            <input
              v-model="addUserId"
              type="text"
              inputmode="numeric"
              :disabled="!isAdmin || addingUser"
              placeholder="123456789"
              class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </div>
          <button
            type="submit"
            :disabled="!isAdmin || addingUser || !addUserId.trim()"
            class="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ addingUser ? 'Adding…' : 'Allow user' }}
          </button>
          <span class="text-xs text-gray-500 dark:text-gray-400 pb-2">You can allow an ID before the user messages the bot.</span>
        </form>

        <div v-if="usersLoading" class="text-center py-6 text-gray-500">Loading users…</div>
        <div v-else-if="sortedUsers.length === 0" class="text-center py-6 text-gray-500 text-sm">
          No Telegram users yet. Send <code class="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-xs">/start</code> to the bot to see your ID here.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th class="px-2 py-2 font-medium sm:px-3">ID</th>
                <th class="px-2 py-2 font-medium sm:px-3">Username</th>
                <th class="hidden px-3 py-2 font-medium md:table-cell">Name</th>
                <th class="hidden px-3 py-2 font-medium lg:table-cell">Last seen</th>
                <th class="px-2 py-2 font-medium sm:px-3">Allowed</th>
                <th class="px-2 py-2 font-medium text-right sm:px-3">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-700">
              <tr
                v-for="user in sortedUsers"
                :key="user.telegram_user_id"
                :class="!user.is_allowed ? 'bg-amber-50/70 dark:bg-amber-900/10' : ''"
              >
                <td class="px-2 py-2 font-mono text-xs text-gray-900 dark:text-white whitespace-nowrap sm:px-3">
                  {{ user.telegram_user_id }}
                  <span
                    v-if="!user.is_allowed"
                    class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-sans font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                  >Pending</span>
                </td>
                <td class="px-2 py-2 text-gray-700 dark:text-gray-300 whitespace-nowrap sm:px-3">
                  {{ displayHandle(user) }}
                  <span class="block text-xs text-gray-500 dark:text-gray-400 md:hidden">{{ displayName(user) }}</span>
                </td>
                <td class="hidden px-3 py-2 text-gray-700 dark:text-gray-300 md:table-cell">{{ displayName(user) }}</td>
                <td class="hidden px-3 py-2 text-gray-500 dark:text-gray-400 text-xs whitespace-nowrap lg:table-cell">{{ formatDateTime(user.last_seen_at) }}</td>
                <td class="px-2 py-2 sm:px-3">
                  <button
                    type="button"
                    role="switch"
                    :aria-checked="user.is_allowed"
                    :disabled="!isAdmin || busyUserId !== null"
                    @click="setUserAllowed(user, !user.is_allowed)"
                    class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    :class="user.is_allowed ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'"
                  >
                    <span
                      class="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform"
                      :class="user.is_allowed ? 'translate-x-[1.125rem]' : 'translate-x-1'"
                    />
                  </button>
                </td>
                <td class="px-2 py-2 text-right whitespace-nowrap sm:px-3">
                  <button
                    v-if="!user.is_allowed"
                    @click="setUserAllowed(user, true)"
                    :disabled="!isAdmin || busyUserId !== null"
                    class="px-2 py-1 text-xs border border-green-300 text-green-700 dark:text-green-400 dark:border-green-700 rounded hover:bg-green-50 dark:hover:bg-green-900/20 disabled:opacity-50"
                  >
                    ✓ Allow
                  </button>
                  <button
                    v-else
                    @click="denyUser(user)"
                    :disabled="!isAdmin || busyUserId !== null"
                    class="px-2 py-1 text-xs border border-red-300 text-red-600 dark:text-red-400 dark:border-red-700 rounded hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                  >
                    ✗ Deny
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Test message + Mini App -->
      <div class="grid gap-6 lg:grid-cols-2 mb-6">
        <!-- Test message -->
        <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 sm:p-6">
          <h2 class="font-semibold text-gray-900 dark:text-white mb-2">Test message</h2>
          <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Send a test message from the global bot to verify the token and a chat ID.
          </p>
          <form @submit.prevent="sendTestMessage" class="space-y-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Chat ID</label>
              <input
                v-model="testChatId"
                type="text"
                :disabled="!isAdmin || testSending"
                placeholder="e.g. 123456789 or -1001234567890"
                class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-60 disabled:cursor-not-allowed"
              />
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Leave empty to use the first allowed user with a known chat ID.
              </p>
            </div>
            <button
              type="submit"
              :disabled="!isAdmin || testSending"
              class="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ testSending ? 'Sending…' : 'Send test message' }}
            </button>
          </form>
          <div
            v-if="testResult"
            class="mt-3 p-2 rounded text-sm"
            :class="testResult.kind === 'success'
              ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
              : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'"
          >
            {{ testResult.kind === 'success' ? '✓' : '✗' }} {{ testResult.text }}
          </div>
        </div>

        <!-- Mini App -->
        <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 sm:p-6">
          <h2 class="font-semibold text-gray-900 dark:text-white mb-2">Telegram Mini App</h2>
          <p class="text-sm text-gray-500 dark:text-gray-400">
            This dashboard can run inside Telegram as a Mini App. Telegram opens the web app URL in its built-in
            browser and signs you in automatically with signed init data.
          </p>
          <div v-if="savedWebappUrl" class="mt-3">
            <p class="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">Configured URL</p>
            <code class="block p-2 rounded bg-gray-100 dark:bg-gray-700 text-xs break-all text-gray-900 dark:text-gray-200">{{ savedWebappUrl }}</code>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              The bot registers the “Open Uptime Detective” menu button when it (re)starts. Use Validate &amp; restart after changing the URL.
            </p>
          </div>
          <p v-else class="mt-3 text-sm text-amber-600 dark:text-amber-400">
            No web app URL configured yet. Set a public HTTPS URL above to enable the Mini App.
          </p>
          <ul class="mt-3 text-xs text-gray-500 dark:text-gray-400 list-disc list-inside space-y-1">
            <li>Requires a public HTTPS URL with a valid certificate.</li>
            <li>The domain must be added to the bot in @BotFather.</li>
            <li>Only allowed Telegram users can sign in through the Mini App.</li>
          </ul>
        </div>
      </div>

      <!-- Commands reference -->
      <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 sm:p-6">
        <h2 class="font-semibold text-gray-900 dark:text-white mb-2">Commands reference</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Send these commands to the bot in Telegram. Monitors can be referenced by ID (<code class="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-xs">12</code>),
          <code class="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-xs">#12</code> or name; use
          <code class="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-xs">all</code> where a target is optional.
        </p>
        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <div
            v-for="item in COMMANDS"
            :key="item.command"
            class="p-3 rounded-lg bg-gray-50 dark:bg-gray-700/40 border border-gray-100 dark:border-gray-700"
          >
            <code class="text-xs font-semibold font-mono text-primary-700 dark:text-primary-300 break-words">{{ item.command }}</code>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">{{ item.description }}</p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
