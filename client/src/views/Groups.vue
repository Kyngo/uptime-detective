<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useApi } from '../composables/useApi.js';
import MonitorSearch from '../components/MonitorSearch.vue';

const api = useApi();
const groups = ref<any[]>([]);
const groupMonitors = ref<Record<number, any[]>>({});
const loading = ref(true);
const showForm = ref(false);
const editingId = ref<number | null>(null);
const form = ref({ name: '', description: '' });
const error = ref('');

async function fetchGroups() {
  loading.value = true;
  try {
    groups.value = await api.get('/api/v1/groups');
    // Fetch monitors for each group
    for (const group of groups.value) {
      await fetchGroupMonitors(group.id);
    }
  } catch (err: any) { error.value = err.message; }
  finally { loading.value = false; }
}

async function fetchGroupMonitors(groupId: number) {
  try {
    groupMonitors.value[groupId] = await api.get(`/api/v1/groups/${groupId}/monitors`);
  } catch {
    groupMonitors.value[groupId] = [];
  }
}

function openCreate() {
  editingId.value = null;
  form.value = { name: '', description: '' };
  showForm.value = true;
}

function openEdit(group: any) {
  editingId.value = group.id;
  form.value = { name: group.name, description: group.description || '' };
  showForm.value = true;
}

async function submit() {
  error.value = '';
  try {
    if (editingId.value) {
      await api.put(`/api/v1/groups/${editingId.value}`, form.value);
    } else {
      await api.post('/api/v1/groups', form.value);
    }
    showForm.value = false;
    await fetchGroups();
  } catch (err: any) { error.value = err.message; }
}

async function deleteGroup(id: number) {
  if (!confirm('Delete this group? Monitors will become ungrouped.')) return;
  await api.del(`/api/v1/groups/${id}`);
  await fetchGroups();
}

async function onMonitorAdded(groupId: number) {
  await fetchGroupMonitors(groupId);
  // Update monitor count in the group list
  const group = groups.value.find(g => g.id === groupId);
  if (group) group.monitor_count = (groupMonitors.value[groupId] || []).length;
}

async function removeMonitor(groupId: number, monitorId: number) {
  try {
    await api.del(`/api/v1/groups/${groupId}/monitors/${monitorId}`);
    await fetchGroupMonitors(groupId);
    const group = groups.value.find(g => g.id === groupId);
    if (group) group.monitor_count = (groupMonitors.value[groupId] || []).length;
  } catch {}
}

function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    http: 'HTTP',
    icmp: 'Ping',
    dns: 'DNS',
    tls: 'TLS',
    tcp: 'TCP',
    heartbeat: 'Heartbeat',
  };
  return labels[type] || type.toUpperCase();
}

onMounted(fetchGroups);
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Groups</h1>
      <button @click="openCreate" class="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 text-sm font-medium">+ New Group</button>
    </div>

    <!-- Form Modal -->
    <div v-if="showForm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showForm = false">
      <div class="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md shadow-xl">
        <h2 class="text-lg font-bold text-gray-900 dark:text-white mb-4">{{ editingId ? 'Edit Group' : 'Create Group' }}</h2>
        <div v-if="error" class="mb-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-red-700 dark:text-red-400 text-sm">{{ error }}</div>
        <form @submit.prevent="submit" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
            <input v-model="form.name" required class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" placeholder="Production Services" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <textarea v-model="form.description" rows="2" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" placeholder="Optional description"></textarea>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" @click="showForm = false" class="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
            <button type="submit" class="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700">{{ editingId ? 'Update' : 'Create' }}</button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-500">Loading...</div>
    <div v-else-if="groups.length === 0" class="text-center py-12 text-gray-500">
      <p class="mb-2">No groups yet.</p>
      <p class="text-sm">Groups let you organize monitors and build status pages.</p>
    </div>
    <div v-else class="grid gap-4">
      <div v-for="group in groups" :key="group.id" class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <!-- Group header -->
        <div class="p-4 flex items-center justify-between">
          <div>
            <h3 class="font-medium text-gray-900 dark:text-white">{{ group.name }}</h3>
            <p class="text-sm text-gray-500">{{ group.monitor_count }} monitor{{ group.monitor_count !== 1 ? 's' : '' }} · /{{ group.slug }}</p>
            <p v-if="group.description" class="text-sm text-gray-400 mt-1">{{ group.description }}</p>
          </div>
          <div class="flex gap-2">
            <button @click="openEdit(group)" class="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700">Edit</button>
            <button @click="deleteGroup(group.id)" class="px-3 py-1.5 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-900/20">Delete</button>
          </div>
        </div>

        <!-- Monitors in group -->
        <div class="border-t border-gray-100 dark:border-gray-700 px-4 py-3 space-y-2">
          <!-- Current monitors -->
          <div v-if="groupMonitors[group.id]?.length" class="flex flex-wrap gap-2 mb-2">
            <span
              v-for="monitor in groupMonitors[group.id]"
              :key="monitor.id"
              class="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-full text-xs"
            >
              <span class="truncate max-w-[150px]">{{ monitor.name }}</span>
              <span class="text-[10px] text-gray-400 dark:text-gray-500">{{ typeLabel(monitor.type) }}</span>
              <button
                @click="removeMonitor(group.id, monitor.id)"
                class="ml-0.5 p-0.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-400 hover:text-red-500 transition-colors"
                title="Remove from group"
              >
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </span>
          </div>

          <!-- Search input -->
          <MonitorSearch :group-id="group.id" @added="onMonitorAdded(group.id)" />
        </div>
      </div>
    </div>
  </div>
</template>
