<script setup lang="ts">
defineProps<{
  bars: { date: string; uptime_pct: number; total_checks: number }[];
}>();

function barColor(pct: number): string {
  if (pct >= 99.5) return 'bg-green-500';
  if (pct >= 95) return 'bg-yellow-500';
  if (pct >= 90) return 'bg-orange-500';
  return 'bg-red-500';
}

function barTitle(bar: { date: string; uptime_pct: number }): string {
  return `${bar.date}: ${bar.uptime_pct}% uptime`;
}
</script>

<template>
  <div class="flex items-end gap-px h-8">
    <div
      v-for="(bar, i) in bars"
      :key="i"
      :class="['flex-1 min-w-[3px] rounded-sm transition-all hover:opacity-80 cursor-default', barColor(bar.uptime_pct)]"
      :style="{ height: `${Math.max(20, bar.uptime_pct)}%` }"
      :title="barTitle(bar)"
    ></div>
    <!-- Fill empty days if less than expected -->
    <div
      v-for="i in Math.max(0, 90 - bars.length)"
      :key="'empty-' + i"
      class="flex-1 min-w-[3px] rounded-sm bg-gray-200 dark:bg-gray-700 h-full"
    ></div>
  </div>
</template>
