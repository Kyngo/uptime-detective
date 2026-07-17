<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useApi } from '../composables/useApi.js';

const api = useApi();
const windows = ref<any[]>([]);
const monitors = ref<any[]>([]);
const loading = ref(true);
const showForm = ref(false);
const editingId = ref<number | null>(null);

const form = ref({ title: '', description: '', start_at: '', end_at: '', recurring: '', monitor_ids: [] as number[] });

async function fetchAll() {
  loading.value = true;
  try {
    windows.value = await api.get('/api/v1/maintenance');
    monitors.value = await api.get('/api/v1/monitors');
  } catch {}
  finally { loading.value = false; }
}

function openCreate() {
  editingId.value = null;
  form.value = { title: '', description: '', start_at: '', end_at: '', recurring: '', monitor_ids: [] };
  showForm.value = true;
}

function openEdit(w: any) {
  editingId.value = w.id;
  form.value = {
    title: w.title,
    description: w.description || '',
    start_at: w.start_at?.slice(0, 16) || '',
    end_at: w.end_at?.slice(0, 16) || '',
    recurring: w.recurring || '',
    monitor_ids: (w.monitors || []).map((m: any) => m.id),
  };
  showForm.value = true;
}

async function submit() {
  try {
    const payload = { ...form.value, recurring: form.value.recurring || null };
    if (editingId.value) {
      await api.put(`/api/v1/maintenance/${editingId.value}`, payload);
    } else {
      await api.post('/api/v1/maintenance', payload);
    }
    showForm.value = false;
    await fetchAll();
  } catch {}
}

async function deleteWindow(id: number) {
  if (!confirm('Delete this maintenance window?')) return;
  await api.del(`/api/v1/maintenance/${id}`);
  await fetchAll();
}

function isActive(w: any): boolean {
  const now = new Date();
  return new Date(w.start_at) <= now && new Date(w.end_at) >= now;
}

function toggleMonitor(id: number) {
  const idx = form.value.monitor_ids.indexOf(id);
  if (idx >= 0) form.value.monitor_ids.splice(idx, 1);
  else form.value.monitor_ids.push(id);
}

onMounted(fetchAll);
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Maintenance Windows</h1>
      <button @click="openCreate" class="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 text-sm font-medium">+ Schedule Maintenance</button>
    </div>

    <!-- Form modal -->
    <div v-if="showForm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showForm = false">
      <div class="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-lg shadow-xl max-h-[80vh] overflow-y-auto">
        <h2 class="text-lg font-bold text-gray-900 dark:text-white mb-4">{{ editingId ? 'Edit' : 'Schedule' }} Maintenance</h2>
        <form @submit.prevent="submit" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title</label>
            <input v-model="form.title" required class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" placeholder="Database maintenance" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <textarea v-model="form.description" rows="2" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"></textarea>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Start</label>
              <input v-model="form.start_at" type="datetime-local" required class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">End</label>
              <input v-model="form.end_at" type="datetime-local" required class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
            </div>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Recurring</label>
            <select v-model="form.recurring" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
              <option value="">None (one-time)</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Affected Monitors</label>
            <div class="max-h-40 overflow-y-auto border border-gray-200 dark:border-gray-600 rounded-lg p-2 space-y-1">
              <label v-for="m in monitors" :key="m.id" class="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">
                <input type="checkbox" :checked="form.monitor_ids.includes(m.id)" @change="toggleMonitor(m.id)" class="rounded" />
                <span class="text-sm text-gray-700 dark:text-gray-300">{{ m.name }}</span>
              </label>
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" @click="showForm = false" class="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg">Cancel</button>
            <button type="submit" class="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700">{{ editingId ? 'Update' : 'Schedule' }}</button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-500">Loading...</div>
    <div v-else-if="windows.length === 0" class="text-center py-12 text-gray-500">
      <p>No maintenance windows scheduled.</p>
      <p class="text-sm mt-1">During maintenance, notifications are suppressed for affected monitors.</p>
    </div>
    <div v-else class="grid gap-3">
      <div v-for="w in windows" :key="w.id" class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="flex items-center gap-2">
              <h3 class="font-medium text-gray-900 dark:text-white">{{ w.title }}</h3>
              <span v-if="isActive(w)" class="px-2 py-0.5 text-xs font-medium rounded bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">Active</span>
              <span v-if="w.recurring" class="px-2 py-0.5 text-xs font-medium rounded bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">{{ w.recurring }}</span>
            </div>
            <p class="text-sm text-gray-500 mt-1">
              {{ new Date(w.start_at).toLocaleString() }} → {{ new Date(w.end_at).toLocaleString() }}
            </p>
            <p v-if="w.monitors?.length" class="text-xs text-gray-400 mt-1">
              Affects: {{ w.monitors.map((m: any) => m.name).join(', ') }}
            </p>
          </div>
          <div class="flex gap-2">
            <button @click="openEdit(w)" class="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700">Edit</button>
            <button @click="deleteWindow(w.id)" class="px-3 py-1.5 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50">Delete</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
