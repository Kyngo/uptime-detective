<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useApi } from '../composables/useApi.js';

const api = useApi();
const channels = ref<any[]>([]);
const loading = ref(true);
const showForm = ref(false);
const editingId = ref<number | null>(null);
const testMsg = ref('');

const form = ref({ name: '', type: 'webhook', config: {} as any, is_default: false });

const configFields = computed(() => {
  switch (form.value.type) {
    case 'webhook': return [{ key: 'url', label: 'Webhook URL', placeholder: 'https://...' }, { key: 'secret', label: 'Secret (optional)', placeholder: 'HMAC secret' }];
    case 'email': return [{ key: 'to', label: 'To Email', placeholder: 'alerts@example.com' }];
    case 'slack': return [{ key: 'webhook_url', label: 'Slack Webhook URL', placeholder: 'https://hooks.slack.com/...' }];
    case 'discord': return [{ key: 'webhook_url', label: 'Discord Webhook URL', placeholder: 'https://discord.com/api/webhooks/...' }];
    case 'telegram': return [{ key: 'bot_token', label: 'Bot Token', placeholder: '123456:ABC-DEF...' }, { key: 'chat_id', label: 'Chat ID', placeholder: '-1001234567890' }];
    default: return [];
  }
});

async function fetchChannels() {
  loading.value = true;
  try { channels.value = await api.get('/api/v1/notifications'); } catch {}
  finally { loading.value = false; }
}

function openCreate() {
  editingId.value = null;
  form.value = { name: '', type: 'webhook', config: {}, is_default: false };
  showForm.value = true;
}

function openEdit(ch: any) {
  editingId.value = ch.id;
  form.value = { name: ch.name, type: ch.type, config: { ...ch.config }, is_default: Boolean(ch.is_default) };
  showForm.value = true;
}

async function submit() {
  try {
    if (editingId.value) {
      await api.put(`/api/v1/notifications/${editingId.value}`, form.value);
    } else {
      await api.post('/api/v1/notifications', form.value);
    }
    showForm.value = false;
    await fetchChannels();
  } catch {}
}

async function deleteChannel(id: number) {
  if (!confirm('Delete this notification channel?')) return;
  await api.del(`/api/v1/notifications/${id}`);
  await fetchChannels();
}

async function testChannel(id: number) {
  testMsg.value = '';
  try {
    await api.post(`/api/v1/notifications/${id}/test`, {});
    testMsg.value = `✓ Test sent to channel #${id}`;
  } catch (err: any) { testMsg.value = `✗ ${err.message}`; }
  setTimeout(() => testMsg.value = '', 4000);
}

function typeIcon(type: string): string {
  const map: Record<string, string> = { webhook: '🔗', email: '📧', slack: '💬', discord: '🎮', telegram: '✈️' };
  return map[type] || '📡';
}

onMounted(fetchChannels);
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Notifications</h1>
      <button @click="openCreate" class="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 text-sm font-medium">+ Add Channel</button>
    </div>

    <div v-if="testMsg" class="mb-4 p-3 rounded-lg text-sm" :class="testMsg.startsWith('✓') ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400' : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'">{{ testMsg }}</div>

    <!-- Form modal -->
    <div v-if="showForm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showForm = false">
      <div class="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md shadow-xl">
        <h2 class="text-lg font-bold text-gray-900 dark:text-white mb-4">{{ editingId ? 'Edit' : 'Create' }} Channel</h2>
        <form @submit.prevent="submit" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
            <input v-model="form.name" required class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" placeholder="My Slack Alerts" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Type</label>
            <select v-model="form.type" @change="form.config = {}" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
              <option value="webhook">Webhook</option>
              <option value="email">Email</option>
              <option value="slack">Slack</option>
              <option value="discord">Discord</option>
              <option value="telegram">Telegram</option>
            </select>
          </div>
          <div v-for="field in configFields" :key="field.key">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ field.label }}</label>
            <input v-model="form.config[field.key]" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" :placeholder="field.placeholder" />
          </div>
          <label class="flex items-center gap-2">
            <input type="checkbox" v-model="form.is_default" class="rounded" />
            <span class="text-sm text-gray-700 dark:text-gray-300">Default channel (notify for all monitors)</span>
          </label>
          <div class="flex justify-end gap-2">
            <button type="button" @click="showForm = false" class="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg">Cancel</button>
            <button type="submit" class="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700">{{ editingId ? 'Update' : 'Create' }}</button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-500">Loading...</div>
    <div v-else-if="channels.length === 0" class="text-center py-12 text-gray-500">
      <p>No notification channels configured.</p>
      <p class="text-sm mt-1">Add a channel to get alerted when monitors go down.</p>
    </div>
    <div v-else class="grid gap-3">
      <div v-for="ch in channels" :key="ch.id" class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <span class="text-xl">{{ typeIcon(ch.type) }}</span>
          <div>
            <h3 class="font-medium text-gray-900 dark:text-white">{{ ch.name }}</h3>
            <p class="text-sm text-gray-500">{{ ch.type }} {{ ch.is_default ? '· Default' : '' }}</p>
          </div>
        </div>
        <div class="flex gap-2">
          <button @click="testChannel(ch.id)" class="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700">🧪 Test</button>
          <button @click="openEdit(ch)" class="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700">Edit</button>
          <button @click="deleteChannel(ch.id)" class="px-3 py-1.5 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50">Delete</button>
        </div>
      </div>
    </div>
  </div>
</template>
