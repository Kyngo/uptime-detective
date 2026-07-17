<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useApi } from '../composables/useApi.js';
import { useSocket } from '../composables/useSocket.js';
import { Line } from 'vue-chartjs';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Title, Tooltip, Legend, Filler,
} from 'chart.js';
import type { MonitorWithStatus, Check } from '@uptime-detective/shared';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const route = useRoute();
const router = useRouter();
const api = useApi();
const { getSocket } = useSocket();

const monitor = ref<MonitorWithStatus | null>(null);
const checks = ref<Check[]>([]);
const uptime = ref<{ uptime_percentage: number; total_checks: number } | null>(null);
const loading = ref(true);
const timeframe = ref('24h');
const monitorId = computed(() => Number(route.params.id));

const chartData = computed(() => {
  const data = [...checks.value].reverse();
  return {
    labels: data.map(c => new Date(c.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    datasets: [{
      label: 'Response Time (ms)',
      data: data.map(c => c.response_time),
      borderColor: '#338dff',
      backgroundColor: 'rgba(51, 141, 255, 0.1)',
      fill: true, tension: 0.3, pointRadius: 0, pointHitRadius: 10,
    }],
  };
});

const chartOptions = {
  responsive: true, maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: { x: { grid: { display: false } }, y: { beginAtZero: true } },
};

async function fetchData() {
  loading.value = true;
  try {
    monitor.value = await api.get(`/api/v1/monitors/${monitorId.value}`);
    const hoursMap: Record<string, number> = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
    const from = new Date(Date.now() - (hoursMap[timeframe.value] || hoursMap['24h'])).toISOString();
    const result = await api.get<{ checks: Check[] }>(`/api/v1/monitors/${monitorId.value}/checks?from=${from}&limit=500`);
    checks.value = result.checks;
    uptime.value = await api.get(`/api/v1/monitors/${monitorId.value}/uptime?days=30`);
  } catch (err: any) { console.error(err); }
  finally { loading.value = false; }
}

watch(timeframe, fetchData);
onMounted(() => {
  fetchData();
  fetchChannels();
  const socket = getSocket();
  socket.emit('subscribe:monitor', monitorId.value);
  socket.on('monitor:status', (data) => {
    if (data.monitor_id === monitorId.value) {
      if (monitor.value) { monitor.value.current_status = data.status; monitor.value.last_check = data.check; }
      checks.value.unshift(data.check);
      if (checks.value.length > 500) checks.value.pop();
    }
  });
});

onUnmounted(() => {
  const socket = getSocket();
  socket.emit('unsubscribe:monitor', monitorId.value);
  socket.off('monitor:status');
});

async function togglePause() {
  if (!monitor.value) return;
  const ep = monitor.value.active ? 'pause' : 'resume';
  monitor.value = await api.post(`/api/v1/monitors/${monitorId.value}/${ep}`, {});
}
async function deleteMonitor() {
  if (!confirm('Delete this monitor and all check data?')) return;
  await api.del(`/api/v1/monitors/${monitorId.value}`);
  router.push('/');
}

// Notification channel management
const linkedChannels = ref<any[]>([]);
const allChannels = ref<any[]>([]);
const showChannelPicker = ref(false);

const availableChannels = computed(() =>
  allChannels.value.filter(ch => !linkedChannels.value.some(lc => lc.id === ch.id))
);

async function fetchChannels() {
  try {
    linkedChannels.value = await api.get(`/api/v1/monitors/${monitorId.value}/notifications`);
    allChannels.value = await api.get('/api/v1/notifications');
  } catch {}
}

async function linkChannel(channelId: number) {
  await api.post(`/api/v1/monitors/${monitorId.value}/notifications/${channelId}`, {});
  await fetchChannels();
  showChannelPicker.value = false;
}

async function unlinkChannel(channelId: number) {
  await api.del(`/api/v1/monitors/${monitorId.value}/notifications/${channelId}`);
  await fetchChannels();
}

function channelIcon(type: string): string {
  const map: Record<string, string> = { webhook: '🔗', email: '📧', slack: '💬', discord: '🎮', telegram: '✈️' };
  return map[type] || '📡';
}
</script>

<template>
  <div v-if="loading" class="text-center py-12 text-gray-500">Loading...</div>
  <div v-else-if="monitor">
    <div class="flex items-start justify-between mb-6">
      <div>
        <div class="flex items-center gap-3">
          <div :class="['w-4 h-4 rounded-full', monitor.current_status === 'up' ? 'bg-green-500' : monitor.current_status === 'down' ? 'bg-red-500' : 'bg-gray-400']"></div>
          <h1 class="text-2xl font-bold text-gray-900 dark:text-white">{{ monitor.name }}</h1>
        </div>
        <p class="text-gray-500 mt-1">{{ monitor.target }}</p>
        <div v-if="monitor.tags && monitor.tags.length > 0" class="flex flex-wrap gap-1.5 mt-2">
          <span v-for="tag in monitor.tags" :key="tag" class="text-xs px-2 py-0.5 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300">{{ tag }}</span>
        </div>
      </div>
      <div class="flex gap-2">
        <button @click="togglePause" class="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700">{{ monitor.active ? '⏸ Pause' : '▶ Resume' }}</button>
        <router-link :to="`/monitors/${monitor.id}/edit`" class="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700">✏️ Edit</router-link>
        <button @click="deleteMonitor" class="px-3 py-2 text-sm rounded-lg border border-red-300 text-red-600 hover:bg-red-50">🗑 Delete</button>
      </div>
    </div>

    <!-- Stats -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div class="text-xl font-bold" :class="monitor.current_status === 'up' ? 'text-green-600' : 'text-red-600'">{{ monitor.current_status.toUpperCase() }}</div>
        <div class="text-xs text-gray-500">Current Status</div>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div class="text-xl font-bold text-gray-900 dark:text-white">{{ monitor.avg_response_time !== null ? `${monitor.avg_response_time}ms` : '—' }}</div>
        <div class="text-xs text-gray-500">Avg Response (24h)</div>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div class="text-xl font-bold" :class="(uptime?.uptime_percentage ?? 100) < 99 ? 'text-red-600' : 'text-green-600'">{{ uptime ? `${uptime.uptime_percentage}%` : '—' }}</div>
        <div class="text-xs text-gray-500">Uptime (30d)</div>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div class="text-xl font-bold text-gray-900 dark:text-white">{{ uptime?.total_checks ?? 0 }}</div>
        <div class="text-xs text-gray-500">Total Checks (30d)</div>
      </div>
    </div>

    <!-- Chart -->
    <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700 mb-6">
      <div class="flex items-center justify-between mb-4">
        <h2 class="font-semibold text-gray-900 dark:text-white">Response Time</h2>
        <div class="flex gap-1">
          <button v-for="tf in ['1h','6h','24h','7d','30d']" :key="tf" @click="timeframe = tf"
            :class="['px-2 py-1 text-xs rounded', timeframe === tf ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700']">{{ tf }}</button>
        </div>
      </div>
      <div class="h-64">
        <Line v-if="checks.length > 0" :data="chartData" :options="chartOptions" />
        <div v-else class="flex items-center justify-center h-full text-gray-400">No check data yet</div>
      </div>
    </div>

    <!-- Recent checks -->
    <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
      <div class="p-4 border-b border-gray-200 dark:border-gray-700">
        <h2 class="font-semibold text-gray-900 dark:text-white">Recent Checks</h2>
      </div>
      <table class="w-full text-sm">
        <thead><tr class="text-left text-xs uppercase text-gray-500 border-b border-gray-200 dark:border-gray-700">
          <th class="p-3">Status</th><th class="p-3">Response</th><th class="p-3">Code</th><th class="p-3">Message</th><th class="p-3">Time</th>
        </tr></thead>
        <tbody>
          <tr v-for="check in checks.slice(0, 20)" :key="check.id" class="border-b border-gray-100 dark:border-gray-700/50">
            <td class="p-3"><span :class="['inline-block w-2 h-2 rounded-full', check.status === 1 ? 'bg-green-500' : 'bg-red-500']"></span></td>
            <td class="p-3">{{ check.response_time ? `${check.response_time}ms` : '—' }}</td>
            <td class="p-3 text-gray-600 dark:text-gray-400">{{ check.status_code || '—' }}</td>
            <td class="p-3 text-gray-600 dark:text-gray-400 truncate max-w-xs">{{ check.message || '—' }}</td>
            <td class="p-3 text-gray-500">{{ new Date(check.created_at).toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Notification channels -->
    <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mt-6">
      <div class="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <h2 class="font-semibold text-gray-900 dark:text-white">🔔 Notification Channels</h2>
        <button @click="showChannelPicker = true" class="px-3 py-1.5 text-xs bg-primary-600 text-white rounded hover:bg-primary-700">+ Link Channel</button>
      </div>
      <div class="p-4">
        <div v-if="linkedChannels.length === 0" class="text-sm text-gray-500">
          No channels linked. Default channels (if any) will still fire.
        </div>
        <div v-else class="space-y-2">
          <div v-for="ch in linkedChannels" :key="ch.id" class="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-700/50 rounded">
            <span class="text-sm"><span class="mr-2">{{ channelIcon(ch.type) }}</span>{{ ch.name }} <span class="text-xs text-gray-400">({{ ch.type }})</span></span>
            <button @click="unlinkChannel(ch.id)" class="text-xs text-red-500 hover:text-red-700">✕ Remove</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Channel picker modal -->
    <div v-if="showChannelPicker" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showChannelPicker = false">
      <div class="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-sm shadow-xl">
        <h3 class="text-lg font-bold text-gray-900 dark:text-white mb-4">Link a Channel</h3>
        <div v-if="availableChannels.length === 0" class="text-sm text-gray-500 py-4">
          No channels available. <router-link to="/notifications" class="text-primary-600">Create one first.</router-link>
        </div>
        <div v-else class="space-y-2">
          <button v-for="ch in availableChannels" :key="ch.id" @click="linkChannel(ch.id)"
            class="w-full text-left px-3 py-2 rounded border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 text-sm">
            <span class="mr-2">{{ channelIcon(ch.type) }}</span>{{ ch.name }} <span class="text-xs text-gray-400">({{ ch.type }})</span>
          </button>
        </div>
        <div class="flex justify-end mt-4">
          <button @click="showChannelPicker = false" class="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>
