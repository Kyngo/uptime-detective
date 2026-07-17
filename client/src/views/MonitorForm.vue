<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useApi } from '../composables/useApi.js';

const route = useRoute();
const router = useRouter();
const api = useApi();

const isEdit = computed(() => !!route.params.id);
const loading = ref(false);
const saving = ref(false);
const error = ref('');

const form = ref({
  name: '',
  type: 'http' as string,
  target: '',
  interval: 60,
  timeout: 10000,
  retries: 1,
  retry_interval: 30,
  config: {
    method: 'GET',
    headers: '',
    body: '',
    body_match: '',
    accepted_status_codes: '200-299',
    follow_redirects: true,
    ignoreTls: true,
  },
  group_id: null as number | null,
  tags: '',
  active: true,
});

const groups = ref<any[]>([]);

onMounted(async () => {
  // Fetch groups for the selector
  try { groups.value = await api.get('/api/v1/groups'); } catch {}

  if (isEdit.value) {
    loading.value = true;
    try {
      const monitor = await api.get<any>(`/api/v1/monitors/${route.params.id}`);
      form.value.name = monitor.name;
      form.value.type = monitor.type;
      form.value.target = monitor.target;
      form.value.interval = monitor.interval;
      form.value.timeout = monitor.timeout;
      form.value.retries = monitor.retries;
      form.value.retry_interval = monitor.retry_interval;
      form.value.active = monitor.active;
      form.value.group_id = monitor.group_id || null;
      form.value.tags = (monitor.tags || []).join(', ');
      form.value.config.method = monitor.config?.method || 'GET';
      form.value.config.headers = monitor.config?.headers ? JSON.stringify(monitor.config.headers, null, 2) : '';
      form.value.config.body = monitor.config?.body || '';
      form.value.config.body_match = monitor.config?.body_match || '';
      form.value.config.accepted_status_codes = monitor.config?.accepted_status_codes || '200-299';
      form.value.config.follow_redirects = monitor.config?.follow_redirects !== false;
      form.value.config.ignoreTls = monitor.config?.ignoreTls !== false;
    } catch (err: any) { error.value = err.message; }
    finally { loading.value = false; }
  }
});

async function submit() {
  saving.value = true;
  error.value = '';
  try {
    let headers: Record<string, string> = {};
    if (form.value.config.headers.trim()) {
      headers = JSON.parse(form.value.config.headers);
    }
    const payload = {
      name: form.value.name,
      type: form.value.type,
      target: form.value.target,
      interval: form.value.interval,
      timeout: form.value.timeout,
      retries: form.value.retries,
      retry_interval: form.value.retry_interval,
      active: form.value.active,
      group_id: form.value.group_id || null,
      tags: form.value.tags.split(',').map(t => t.trim()).filter(Boolean),
      config: {
        method: form.value.config.method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: form.value.config.body || undefined,
        body_match: form.value.config.body_match || undefined,
        accepted_status_codes: form.value.config.accepted_status_codes,
        follow_redirects: form.value.config.follow_redirects,
        ignoreTls: form.value.config.ignoreTls,
      },
    };
    if (isEdit.value) {
      await api.put(`/api/v1/monitors/${route.params.id}`, payload);
      router.push(`/monitors/${route.params.id}`);
    } else {
      const created = await api.post<any>('/api/v1/monitors', payload);
      router.push(`/monitors/${created.id}`);
    }
  } catch (err: any) { error.value = err.message; }
  finally { saving.value = false; }
}
</script>

<template>
  <div class="max-w-2xl">
    <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-6">{{ isEdit ? 'Edit Monitor' : 'Create Monitor' }}</h1>

    <div v-if="error" class="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm">{{ error }}</div>

    <form @submit.prevent="submit" class="space-y-5">
      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
        <input v-model="form.name" required class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent" placeholder="My Website" />
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Type</label>
          <select v-model="form.type" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
            <option value="http">HTTP(S)</option>
            <option value="icmp">ICMP Ping</option>
            <option value="dns">DNS</option>
            <option value="tls">TLS/SSL</option>
            <option value="tcp">TCP Port</option>
            <option value="heartbeat">Heartbeat (Push)</option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Target (URL / Host)</label>
          <input v-model="form.target" required class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white" placeholder="https://example.com" />
        </div>
      </div>

      <div v-if="groups.length > 0">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Group</label>
        <select v-model="form.group_id" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
          <option :value="null">No group</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </select>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Interval (s)</label>
          <input v-model.number="form.interval" type="number" min="20" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Timeout (ms)</label>
          <input v-model.number="form.timeout" type="number" min="1000" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Retries</label>
          <input v-model.number="form.retries" type="number" min="0" max="5" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Retry Interval (s)</label>
          <input v-model.number="form.retry_interval" type="number" min="5" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
        </div>
      </div>

      <!-- HTTP-specific config -->
      <div v-if="form.type === 'http'" class="space-y-4 border-t border-gray-200 dark:border-gray-700 pt-4">
        <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300">HTTP Settings</h3>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Method</label>
            <select v-model="form.config.method" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
              <option v-for="m in ['GET','POST','HEAD','PUT','DELETE','PATCH']" :key="m">{{ m }}</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Accepted Status Codes</label>
            <input v-model="form.config.accepted_status_codes" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white" placeholder="200-299" />
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Headers (JSON)</label>
          <textarea v-model="form.config.headers" rows="3" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white font-mono text-xs" placeholder='{"Authorization": "Bearer ..."}'></textarea>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Body (for POST/PUT)</label>
          <textarea v-model="form.config.body" rows="3" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white font-mono text-xs"></textarea>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Body Match (regex)</label>
          <input v-model="form.config.body_match" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white" placeholder="OK|success" />
        </div>
        <label class="flex items-center gap-2">
          <input type="checkbox" v-model="form.config.follow_redirects" class="rounded" />
          <span class="text-sm text-gray-700 dark:text-gray-300">Follow redirects</span>
        </label>
        <label class="flex items-center gap-2">
          <input type="checkbox" v-model="form.config.ignoreTls" class="rounded" />
          <span class="text-sm text-gray-700 dark:text-gray-300">Ignore TLS/SSL certificate errors</span>
        </label>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tags (comma-separated)</label>
        <input v-model="form.tags" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white" placeholder="production, api, critical" />
      </div>

      <div class="flex items-center justify-between pt-4">
        <label class="flex items-center gap-2">
          <input type="checkbox" v-model="form.active" class="rounded" />
          <span class="text-sm text-gray-700 dark:text-gray-300">Active (start monitoring immediately)</span>
        </label>
        <div class="flex gap-3">
          <button type="button" @click="router.back()" class="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
          <button type="submit" :disabled="saving" class="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
            {{ saving ? 'Saving...' : (isEdit ? 'Update Monitor' : 'Create Monitor') }}
          </button>
        </div>
      </div>
    </form>
  </div>
</template>
