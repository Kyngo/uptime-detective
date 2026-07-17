<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useSocket } from '../composables/useSocket.js';
import { resetSetupStatus } from '../router/index.js';

const router = useRouter();
const auth = useAuthStore();
const { connect } = useSocket();

// Wizard state
const step = ref(1);
const totalSteps = 3;
const loading = ref(false);
const error = ref('');

// Step 1: Admin account
const username = ref('');
const password = ref('');
const confirmPassword = ref('');

// Step 2: Notifications
interface NotificationChannel {
  name: string;
  type: 'webhook' | 'email' | 'slack' | 'discord' | 'telegram';
  config: Record<string, string>;
  is_default: boolean;
}

const notifications = ref<NotificationChannel[]>([]);
const showNotifForm = ref(false);
const notifForm = ref<NotificationChannel>({
  name: '',
  type: 'webhook',
  config: {},
  is_default: false,
});

const configFields = computed(() => {
  switch (notifForm.value.type) {
    case 'webhook':
      return [{ key: 'url', label: 'Webhook URL', placeholder: 'https://example.com/webhook' }];
    case 'email':
      return [{ key: 'to', label: 'Recipient Email', placeholder: 'alerts@example.com' }];
    case 'slack':
      return [{ key: 'webhook_url', label: 'Slack Webhook URL', placeholder: 'https://hooks.slack.com/services/...' }];
    case 'discord':
      return [{ key: 'webhook_url', label: 'Discord Webhook URL', placeholder: 'https://discord.com/api/webhooks/...' }];
    case 'telegram':
      return [
        { key: 'bot_token', label: 'Bot Token', placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11' },
        { key: 'chat_id', label: 'Chat ID', placeholder: '-1001234567890' },
      ];
    default:
      return [];
  }
});

// Validation
const step1Valid = computed(() => {
  return (
    username.value.length >= 3 &&
    password.value.length >= 6 &&
    password.value === confirmPassword.value
  );
});

const passwordMismatch = computed(() => {
  return confirmPassword.value.length > 0 && password.value !== confirmPassword.value;
});

// Navigation
function nextStep() {
  if (step.value < totalSteps) {
    step.value++;
  }
}

function prevStep() {
  if (step.value > 1) {
    step.value--;
  }
}

// Notification management
function addNotification() {
  notifications.value.push({ ...notifForm.value });
  notifForm.value = { name: '', type: 'webhook', config: {}, is_default: false };
  showNotifForm.value = false;
}

function removeNotification(index: number) {
  notifications.value.splice(index, 1);
}

function openNotifForm() {
  notifForm.value = { name: '', type: 'webhook', config: {}, is_default: false };
  showNotifForm.value = true;
}

// Submit
async function completeSetup() {
  error.value = '';
  loading.value = true;

  try {
    const response = await fetch('/api/v1/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username.value,
        password: password.value,
        notifications: notifications.value,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Setup failed');
    }

    const data = await response.json();

    // Auto-login with the returned token
    localStorage.setItem('token', data.token);
    auth.token = data.token;
    auth.user = data.user;
    connect();

    // Reset cached setup status so the guard allows normal navigation
    resetSetupStatus();
    router.push('/');
  } catch (err: any) {
    error.value = err.message || 'Setup failed';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4 py-8">
    <div class="w-full max-w-lg">
      <!-- Header -->
      <div class="text-center mb-8">
        <span class="text-5xl">🔍</span>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white mt-3">Welcome to Uptime Detective</h1>
        <p class="text-gray-500 dark:text-gray-400 mt-1">Let's set up your monitoring instance</p>
      </div>

      <!-- Progress indicator -->
      <div class="flex items-center justify-center mb-8 space-x-2">
        <template v-for="s in totalSteps" :key="s">
          <div
            :class="[
              'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors',
              s <= step
                ? 'bg-primary-600 text-white'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
            ]"
          >
            {{ s }}
          </div>
          <div
            v-if="s < totalSteps"
            :class="[
              'w-12 h-0.5 transition-colors',
              s < step ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-700',
            ]"
          />
        </template>
      </div>

      <!-- Card -->
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <!-- Error -->
        <div v-if="error" class="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm">
          {{ error }}
        </div>

        <!-- Step 1: Admin Account -->
        <div v-if="step === 1">
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-1">Create Admin Account</h2>
          <p class="text-sm text-gray-500 dark:text-gray-400 mb-5">This will be your primary administrator account.</p>

          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
              <input
                v-model="username"
                type="text"
                class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                placeholder="admin"
                autofocus
              />
              <p v-if="username.length > 0 && username.length < 3" class="mt-1 text-xs text-red-500">
                Must be at least 3 characters
              </p>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
              <input
                v-model="password"
                type="password"
                class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                placeholder="••••••••"
              />
              <p v-if="password.length > 0 && password.length < 6" class="mt-1 text-xs text-red-500">
                Must be at least 6 characters
              </p>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Confirm Password</label>
              <input
                v-model="confirmPassword"
                type="password"
                class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                placeholder="••••••••"
              />
              <p v-if="passwordMismatch" class="mt-1 text-xs text-red-500">
                Passwords don't match
              </p>
            </div>
          </div>
        </div>

        <!-- Step 2: Notifications -->
        <div v-if="step === 2">
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-1">Notification Channels</h2>
          <p class="text-sm text-gray-500 dark:text-gray-400 mb-5">
            Configure how you want to be alerted when monitors go down. You can skip this and set it up later.
          </p>

          <!-- List of added channels -->
          <div v-if="notifications.length > 0" class="space-y-2 mb-4">
            <div
              v-for="(notif, index) in notifications"
              :key="index"
              class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600"
            >
              <div>
                <span class="text-sm font-medium text-gray-900 dark:text-white">{{ notif.name }}</span>
                <span class="ml-2 text-xs px-2 py-0.5 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 uppercase">
                  {{ notif.type }}
                </span>
              </div>
              <button
                @click="removeNotification(index)"
                class="text-red-500 hover:text-red-700 text-sm"
              >
                Remove
              </button>
            </div>
          </div>

          <!-- Add notification form -->
          <div v-if="showNotifForm" class="border border-gray-200 dark:border-gray-600 rounded-lg p-4 mb-4 space-y-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Channel Name</label>
              <input
                v-model="notifForm.name"
                type="text"
                class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                placeholder="My Alerts"
              />
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Type</label>
              <select
                v-model="notifForm.type"
                @change="notifForm.config = {}"
                class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              >
                <option value="webhook">Webhook</option>
                <option value="email">Email</option>
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
                <option value="telegram">Telegram</option>
              </select>
            </div>

            <div v-for="field in configFields" :key="field.key">
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ field.label }}</label>
              <input
                v-model="notifForm.config[field.key]"
                type="text"
                class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                :placeholder="field.placeholder"
              />
            </div>

            <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input v-model="notifForm.is_default" type="checkbox" class="rounded border-gray-300 dark:border-gray-600" />
              Set as default for new monitors
            </label>

            <div class="flex gap-2">
              <button
                @click="addNotification"
                :disabled="!notifForm.name || configFields.some(f => !notifForm.config[f.key])"
                class="px-3 py-1.5 bg-primary-600 text-white text-sm rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                Add Channel
              </button>
              <button
                @click="showNotifForm = false"
                class="px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>

          <button
            v-if="!showNotifForm"
            @click="openNotifForm"
            class="w-full py-2 px-4 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-gray-500 dark:text-gray-400 hover:border-primary-500 hover:text-primary-600 transition-colors text-sm"
          >
            + Add Notification Channel
          </button>
        </div>

        <!-- Step 3: Review & Confirm -->
        <div v-if="step === 3">
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-1">Review & Complete</h2>
          <p class="text-sm text-gray-500 dark:text-gray-400 mb-5">Confirm your settings before completing setup.</p>

          <div class="space-y-4">
            <div class="p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Admin Account</h3>
              <p class="text-gray-900 dark:text-white font-medium">{{ username }}</p>
            </div>

            <div class="p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Notifications</h3>
              <div v-if="notifications.length > 0" class="space-y-1">
                <div v-for="(notif, i) in notifications" :key="i" class="flex items-center gap-2">
                  <span class="text-gray-900 dark:text-white text-sm">{{ notif.name }}</span>
                  <span class="text-xs text-gray-500 dark:text-gray-400">({{ notif.type }})</span>
                </div>
              </div>
              <p v-else class="text-sm text-gray-500 dark:text-gray-400 italic">No channels configured — you can add them later.</p>
            </div>
          </div>
        </div>

        <!-- Navigation buttons -->
        <div class="mt-6 flex justify-between">
          <button
            v-if="step > 1"
            @click="prevStep"
            class="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Back
          </button>
          <div v-else></div>

          <button
            v-if="step < totalSteps"
            @click="nextStep"
            :disabled="step === 1 && !step1Valid"
            class="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            Continue
          </button>

          <button
            v-else
            @click="completeSetup"
            :disabled="loading"
            class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {{ loading ? 'Setting up...' : 'Complete Setup' }}
          </button>
        </div>
      </div>

      <p class="text-center text-xs text-gray-400 dark:text-gray-500 mt-4">
        You can change these settings later in the dashboard.
      </p>
    </div>
  </div>
</template>
