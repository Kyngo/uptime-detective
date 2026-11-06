<script setup lang="ts">
import { ref, watch } from 'vue';
import { useApi } from '../composables/useApi.js';

const props = defineProps<{
  groupId: number;
}>();

const emit = defineEmits<{
  added: [];
}>();

const api = useApi();
const query = ref('');
const results = ref<any[]>([]);
const showDropdown = ref(false);
const loading = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(query, (val) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (!val.trim()) {
    results.value = [];
    showDropdown.value = false;
    return;
  }
  debounceTimer = setTimeout(() => searchMonitors(val.trim()), 250);
});

async function searchMonitors(search: string) {
  loading.value = true;
  try {
    results.value = await api.get(`/api/v1/groups/available-monitors?search=${encodeURIComponent(search)}&exclude_group=${props.groupId}`);
    showDropdown.value = results.value.length > 0;
  } catch {
    results.value = [];
  } finally {
    loading.value = false;
  }
}

async function addMonitor(monitor: any) {
  try {
    await api.post(`/api/v1/groups/${props.groupId}/monitors`, { monitor_id: monitor.id });
    query.value = '';
    results.value = [];
    showDropdown.value = false;
    emit('added');
  } catch (err: any) {
    // Silently fail or could emit error
  }
}

function onBlur() {
  // Delay to allow click on dropdown item
  setTimeout(() => { showDropdown.value = false; }, 150);
}

function onFocus() {
  if (results.value.length > 0) showDropdown.value = true;
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
</script>

<template>
  <div class="relative">
    <input
      ref="inputRef"
      v-model="query"
      type="text"
      placeholder="Type to add a monitor..."
      class="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none"
      @focus="onFocus"
      @blur="onBlur"
    />
    <div v-if="loading" class="absolute right-2 top-1/2 -translate-y-1/2">
      <svg class="animate-spin h-4 w-4 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
      </svg>
    </div>

    <!-- Dropdown -->
    <div
      v-if="showDropdown"
      class="absolute z-50 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg max-h-48 overflow-y-auto"
    >
      <button
        v-for="monitor in results"
        :key="monitor.id"
        class="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center justify-between gap-2 text-sm transition-colors"
        @mousedown.prevent="addMonitor(monitor)"
      >
        <span class="text-gray-900 dark:text-white truncate">{{ monitor.name }}</span>
        <span class="text-xs px-1.5 py-0.5 bg-gray-100 dark:bg-gray-600 text-gray-600 dark:text-gray-300 rounded shrink-0">{{ typeLabel(monitor.type) }}</span>
      </button>
    </div>

    <!-- No results -->
    <div
      v-if="query.trim() && !loading && results.length === 0 && showDropdown === false && query.length >= 2"
      class="absolute z-50 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg px-3 py-2 text-sm text-gray-500"
    >
      No available monitors found
    </div>
  </div>
</template>
