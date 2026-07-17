<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useApi } from '../composables/useApi.js';
import { useSocket } from '../composables/useSocket.js';
import type { MonitorWithStatus } from '@uptime-detective/shared';

const api = useApi();
const { getSocket } = useSocket();
const monitors = ref<MonitorWithStatus[]>([]);
const groups = ref<any[]>([]);
const loading = ref(true);
const error = ref('');
const collapsedGroups = ref<Set<string>>(new Set());

const summary = computed(() => {
  const total = monitors.value.length;
  const up = monitors.value.filter(m => m.current_status === 'up').length;
  const down = monitors.value.filter(m => m.current_status === 'down').length;
  const paused = monitors.value.filter(m => !m.active).length;
  return { total, up, down, paused };
});

interface MonitorGroup {
  id: number | null;
  name: string;
  slug: string;
  monitors: MonitorWithStatus[];
}

const groupedMonitors = computed<MonitorGroup[]>(() => {
  const groupMap = new Map<number | null, MonitorGroup>();

  for (const g of groups.value) {
    groupMap.set(g.id, { id: g.id, name: g.name, slug: g.slug, monitors: [] });
  }
  groupMap.set(null, { id: null, name: 'Ungrouped', slug: 'ungrouped', monitors: [] });

  for (const monitor of monitors.value) {
    const groupId = monitor.group_id || null;
    if (groupMap.has(groupId)) {
      groupMap.get(groupId)!.monitors.push(monitor);
    } else {
      groupMap.get(null)!.monitors.push(monitor);
    }
  }

  const result: MonitorGroup[] = [];
  for (const g of groups.value) {
    const group = groupMap.get(g.id)!;
    if (group.monitors.length > 0) result.push(group);
  }
  const ungrouped = groupMap.get(null)!;
  if (ungrouped.monitors.length > 0) result.push(ungrouped);

  return result;
});

// Distribute groups across two columns (round-robin)
const leftColumn = computed(() => groupedMonitors.value.filter((_, i) => i % 2 === 0));
const rightColumn = computed(() => groupedMonitors.value.filter((_, i) => i % 2 === 1));

function toggleGroup(slug: string) {
  if (collapsedGroups.value.has(slug)) {
    collapsedGroups.value.delete(slug);
  } else {
    collapsedGroups.value.add(slug);
  }
}

function isCollapsed(slug: string): boolean {
  return collapsedGroups.value.has(slug);
}

function groupStatus(group: MonitorGroup): string {
  if (group.monitors.some(m => m.current_status === 'down')) return 'down';
  if (group.monitors.some(m => m.current_status === 'degraded')) return 'degraded';
  if (group.monitors.every(m => m.current_status === 'up')) return 'up';
  return 'pending';
}

function groupStatusColor(status: string): string {
  const map: Record<string, string> = { up: 'bg-green-500', down: 'bg-red-500', degraded: 'bg-yellow-500' };
  return map[status] || 'bg-gray-400';
}

function statusColor(status: string): string {
  const map: Record<string, string> = { up: 'bg-green-500', down: 'bg-red-500', degraded: 'bg-yellow-500', maintenance: 'bg-blue-500' };
  return map[status] || 'bg-gray-400';
}

async function fetchMonitors() {
  try {
    const [monitorsData, groupsData] = await Promise.all([
      api.get<MonitorWithStatus[]>('/api/v1/monitors'),
      api.get<any[]>('/api/v1/groups'),
    ]);
    monitors.value = monitorsData;
    groups.value = groupsData;
    error.value = '';

    // Collapse all groups by default except "Ungrouped"
    for (const g of groupsData) {
      collapsedGroups.value.add(g.slug);
    }
  } catch (err: any) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  fetchMonitors();
  const socket = getSocket();
  socket.on('monitor:status', (data) => {
    const idx = monitors.value.findIndex(m => m.id === data.monitor_id);
    if (idx !== -1) {
      monitors.value[idx].current_status = data.status;
      monitors.value[idx].last_check = data.check;
    }
  });
  socket.on('monitor:created', (monitor) => {
    monitors.value.push({ ...monitor, current_status: 'pending', last_check: null, uptime_24h: null, avg_response_time: null });
  });
  socket.on('monitor:deleted', ({ monitor_id }) => {
    monitors.value = monitors.value.filter(m => m.id !== monitor_id);
  });
});
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
      <router-link to="/monitors/new" class="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 text-sm font-medium">
        + Add Monitor
      </router-link>
    </div>

    <!-- Summary stats -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div class="text-2xl font-bold text-gray-900 dark:text-white">{{ summary.total }}</div>
        <div class="text-sm text-gray-500">Total Monitors</div>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div class="text-2xl font-bold text-green-600">{{ summary.up }}</div>
        <div class="text-sm text-gray-500">Up</div>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div class="text-2xl font-bold text-red-600">{{ summary.down }}</div>
        <div class="text-sm text-gray-500">Down</div>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div class="text-2xl font-bold text-gray-500">{{ summary.paused }}</div>
        <div class="text-sm text-gray-500">Paused</div>
      </div>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-500">Loading monitors...</div>
    <div v-else-if="error" class="text-center py-12 text-red-600">{{ error }}</div>
    <div v-else-if="monitors.length === 0" class="text-center py-12">
      <p class="text-gray-500 text-lg mb-4">No monitors yet</p>
      <router-link to="/monitors/new" class="text-primary-600 hover:text-primary-700 font-medium">Create your first monitor →</router-link>
    </div>

    <!-- Desktop: two fixed columns -->
    <div v-else class="hidden lg:grid grid-cols-2 gap-4 items-start">
      <div class="space-y-4">
        <template v-for="group in leftColumn" :key="group.slug">
          <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <button @click="toggleGroup(group.slug)" class="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left">
              <svg :class="['w-4 h-4 text-gray-400 transition-transform', isCollapsed(group.slug) ? '-rotate-90' : '']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" /></svg>
              <div :class="['w-2.5 h-2.5 rounded-full flex-shrink-0', groupStatusColor(groupStatus(group))]"></div>
              <h2 class="font-semibold text-gray-900 dark:text-white text-sm flex-1">{{ group.name }}</h2>
              <span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">{{ group.monitors.length }}</span>
              <span class="text-xs text-green-600">{{ group.monitors.filter(m => m.current_status === 'up').length }} up</span>
              <span v-if="group.monitors.some(m => m.current_status === 'down')" class="text-xs text-red-600">{{ group.monitors.filter(m => m.current_status === 'down').length }} down</span>
            </button>
            <div v-show="!isCollapsed(group.slug)" class="border-t border-gray-100 dark:border-gray-700">
              <router-link v-for="monitor in group.monitors" :key="monitor.id" :to="`/monitors/${monitor.id}`" class="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors border-b border-gray-100 dark:border-gray-700 last:border-b-0">
                <div :class="['w-3 h-3 rounded-full flex-shrink-0', statusColor(monitor.current_status)]"></div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <h3 class="font-medium text-gray-900 dark:text-white truncate text-sm">{{ monitor.name }}</h3>
                    <span class="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 uppercase">{{ monitor.type }}</span>
                    <template v-if="monitor.tags && monitor.tags.length > 0">
                      <span v-for="tag in monitor.tags" :key="tag" class="text-xs px-1.5 py-0.5 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300">{{ tag }}</span>
                    </template>
                  </div>
                  <p class="text-xs text-gray-500 truncate">{{ monitor.target }}</p>
                </div>
                <div class="flex items-center gap-6 text-sm text-right">
                  <div>
                    <div class="text-gray-900 dark:text-white font-medium text-sm">{{ monitor.avg_response_time !== null ? `${monitor.avg_response_time}ms` : '—' }}</div>
                    <div class="text-xs text-gray-500">Avg Response</div>
                  </div>
                  <div>
                    <div class="font-medium text-sm" :class="monitor.uptime_24h !== null && monitor.uptime_24h < 99 ? 'text-red-600' : 'text-green-600'">{{ monitor.uptime_24h !== null ? `${monitor.uptime_24h}%` : '—' }}</div>
                    <div class="text-xs text-gray-500">24h Uptime</div>
                  </div>
                </div>
              </router-link>
            </div>
          </div>
        </template>
      </div>
      <div class="space-y-4">
        <template v-for="group in rightColumn" :key="group.slug">
          <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <button @click="toggleGroup(group.slug)" class="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left">
              <svg :class="['w-4 h-4 text-gray-400 transition-transform', isCollapsed(group.slug) ? '-rotate-90' : '']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" /></svg>
              <div :class="['w-2.5 h-2.5 rounded-full flex-shrink-0', groupStatusColor(groupStatus(group))]"></div>
              <h2 class="font-semibold text-gray-900 dark:text-white text-sm flex-1">{{ group.name }}</h2>
              <span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">{{ group.monitors.length }}</span>
              <span class="text-xs text-green-600">{{ group.monitors.filter(m => m.current_status === 'up').length }} up</span>
              <span v-if="group.monitors.some(m => m.current_status === 'down')" class="text-xs text-red-600">{{ group.monitors.filter(m => m.current_status === 'down').length }} down</span>
            </button>
            <div v-show="!isCollapsed(group.slug)" class="border-t border-gray-100 dark:border-gray-700">
              <router-link v-for="monitor in group.monitors" :key="monitor.id" :to="`/monitors/${monitor.id}`" class="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors border-b border-gray-100 dark:border-gray-700 last:border-b-0">
                <div :class="['w-3 h-3 rounded-full flex-shrink-0', statusColor(monitor.current_status)]"></div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <h3 class="font-medium text-gray-900 dark:text-white truncate text-sm">{{ monitor.name }}</h3>
                    <span class="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 uppercase">{{ monitor.type }}</span>
                    <template v-if="monitor.tags && monitor.tags.length > 0">
                      <span v-for="tag in monitor.tags" :key="tag" class="text-xs px-1.5 py-0.5 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300">{{ tag }}</span>
                    </template>
                  </div>
                  <p class="text-xs text-gray-500 truncate">{{ monitor.target }}</p>
                </div>
                <div class="flex items-center gap-6 text-sm text-right">
                  <div>
                    <div class="text-gray-900 dark:text-white font-medium text-sm">{{ monitor.avg_response_time !== null ? `${monitor.avg_response_time}ms` : '—' }}</div>
                    <div class="text-xs text-gray-500">Avg Response</div>
                  </div>
                  <div>
                    <div class="font-medium text-sm" :class="monitor.uptime_24h !== null && monitor.uptime_24h < 99 ? 'text-red-600' : 'text-green-600'">{{ monitor.uptime_24h !== null ? `${monitor.uptime_24h}%` : '—' }}</div>
                    <div class="text-xs text-gray-500">24h Uptime</div>
                  </div>
                </div>
              </router-link>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Mobile: single column -->
    <div v-if="!loading && !error && monitors.length > 0" class="lg:hidden space-y-4">
      <div v-for="group in groupedMonitors" :key="group.slug" class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <button @click="toggleGroup(group.slug)" class="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left">
          <svg :class="['w-4 h-4 text-gray-400 transition-transform', isCollapsed(group.slug) ? '-rotate-90' : '']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" /></svg>
          <div :class="['w-2.5 h-2.5 rounded-full flex-shrink-0', groupStatusColor(groupStatus(group))]"></div>
          <h2 class="font-semibold text-gray-900 dark:text-white text-sm flex-1">{{ group.name }}</h2>
          <span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">{{ group.monitors.length }}</span>
          <span class="text-xs text-green-600">{{ group.monitors.filter(m => m.current_status === 'up').length }} up</span>
          <span v-if="group.monitors.some(m => m.current_status === 'down')" class="text-xs text-red-600">{{ group.monitors.filter(m => m.current_status === 'down').length }} down</span>
        </button>
        <div v-show="!isCollapsed(group.slug)" class="border-t border-gray-100 dark:border-gray-700">
          <router-link v-for="monitor in group.monitors" :key="monitor.id" :to="`/monitors/${monitor.id}`" class="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors border-b border-gray-100 dark:border-gray-700 last:border-b-0">
            <div :class="['w-3 h-3 rounded-full flex-shrink-0', statusColor(monitor.current_status)]"></div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="font-medium text-gray-900 dark:text-white truncate text-sm">{{ monitor.name }}</h3>
                <span class="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 uppercase">{{ monitor.type }}</span>
                <template v-if="monitor.tags && monitor.tags.length > 0">
                  <span v-for="tag in monitor.tags" :key="tag" class="text-xs px-1.5 py-0.5 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300">{{ tag }}</span>
                </template>
              </div>
              <p class="text-xs text-gray-500 truncate">{{ monitor.target }}</p>
            </div>
            <div class="hidden sm:flex items-center gap-6 text-sm text-right">
              <div>
                <div class="text-gray-900 dark:text-white font-medium text-sm">{{ monitor.avg_response_time !== null ? `${monitor.avg_response_time}ms` : '—' }}</div>
                <div class="text-xs text-gray-500">Avg Response</div>
              </div>
              <div>
                <div class="font-medium text-sm" :class="monitor.uptime_24h !== null && monitor.uptime_24h < 99 ? 'text-red-600' : 'text-green-600'">{{ monitor.uptime_24h !== null ? `${monitor.uptime_24h}%` : '—' }}</div>
                <div class="text-xs text-gray-500">24h Uptime</div>
              </div>
            </div>
          </router-link>
        </div>
      </div>
    </div>
  </div>
</template>
