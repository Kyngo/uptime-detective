<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import UptimeBar from '../components/UptimeBar.vue';

const route = useRoute();
const data = ref<any>(null);
const loading = ref(true);
const error = ref('');

const overallLabel = computed(() => {
  const map: Record<string, string> = {
    operational: 'All Systems Operational',
    degraded_performance: 'Degraded Performance',
    partial_outage: 'Partial Outage',
    major_outage: 'Major Outage',
    maintenance: 'Scheduled Maintenance',
  };
  return map[data.value?.overall_status] || 'Unknown';
});

const overallColor = computed(() => {
  const map: Record<string, string> = {
    operational: 'bg-green-500',
    degraded_performance: 'bg-yellow-500',
    partial_outage: 'bg-orange-500',
    major_outage: 'bg-red-500',
    maintenance: 'bg-blue-500',
  };
  return map[data.value?.overall_status] || 'bg-gray-400';
});

onMounted(async () => {
  try {
    const slug = route.params.slug as string;
    const resp = await fetch(`/api/v1/status/${slug}`);
    if (!resp.ok) throw new Error('Status page not found');
    data.value = await resp.json();
  } catch (err: any) { error.value = err.message; }
  finally { loading.value = false; }
});

function statusDot(status: string): string {
  const map: Record<string, string> = { up: 'bg-green-500', down: 'bg-red-500', degraded: 'bg-yellow-500', maintenance: 'bg-blue-500' };
  return map[status] || 'bg-gray-400';
}

function statusText(status: string): string {
  const map: Record<string, string> = { up: 'Operational', down: 'Down', degraded: 'Degraded', maintenance: 'Maintenance', pending: 'Pending' };
  return map[status] || 'Unknown';
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-900 px-4 py-8">
    <div class="max-w-3xl mx-auto">
      <div v-if="loading" class="text-center py-20 text-gray-500">Loading status page...</div>
      <div v-else-if="error" class="text-center py-20 text-red-500">{{ error }}</div>
      <div v-else-if="data">
        <!-- Header -->
        <div class="text-center mb-8">
          <img v-if="data.logo_url" :src="data.logo_url" alt="Logo" class="h-10 mx-auto mb-3" />
          <h1 class="text-2xl font-bold text-gray-900 dark:text-white">{{ data.title }}</h1>
          <p v-if="data.description" class="text-gray-500 dark:text-gray-400 mt-1">{{ data.description }}</p>
        </div>

        <!-- Overall status banner -->
        <div :class="['rounded-lg p-4 mb-8 text-white text-center font-semibold', overallColor]">
          {{ overallLabel }}
        </div>

        <!-- Sections -->
        <div v-for="(section, si) in data.sections" :key="si" class="mb-8">
          <h2 v-if="section.type === 'group'" class="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-3">
            {{ section.group.name }}
          </h2>

          <div class="space-y-3">
            <div v-for="monitor in section.monitors" :key="monitor.id"
              class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
              <!-- Monitor header -->
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <div :class="['w-2.5 h-2.5 rounded-full', statusDot(monitor.current_status)]"></div>
                  <span class="font-medium text-gray-900 dark:text-white">{{ monitor.name }}</span>
                </div>
                <div class="flex items-center gap-3 text-sm">
                  <span class="text-gray-500">{{ monitor.uptime_90d }}% uptime</span>
                  <span :class="['text-xs font-medium', monitor.current_status === 'up' ? 'text-green-600' : 'text-red-600']">
                    {{ statusText(monitor.current_status) }}
                  </span>
                </div>
              </div>

              <!-- Uptime bars -->
              <UptimeBar :bars="monitor.daily_bars" />
              <div class="flex justify-between text-xs text-gray-400 mt-1">
                <span>90 days ago</span>
                <span>Today</span>
              </div>

              <!-- Recent incidents -->
              <div v-if="monitor.incidents.length > 0" class="mt-3 border-t border-gray-100 dark:border-gray-700 pt-3">
                <h4 class="text-xs font-semibold text-gray-500 uppercase mb-2">Recent Incidents</h4>
                <div v-for="inc in monitor.incidents.slice(0, 3)" :key="inc.started_at" class="text-xs text-gray-600 dark:text-gray-400 mb-1">
                  <span class="text-red-500">●</span>
                  {{ new Date(inc.started_at).toLocaleDateString() }} —
                  {{ inc.cause || 'Downtime detected' }}
                  <span v-if="inc.duration_seconds" class="text-gray-400">({{ Math.round(inc.duration_seconds / 60) }}min)</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div v-if="data.show_powered_by" class="text-center text-xs text-gray-400 mt-12">
          Powered by <span class="font-medium">Uptime Detective</span>
        </div>
      </div>
    </div>
  </div>
</template>
