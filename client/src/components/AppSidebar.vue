<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

defineProps<{ isDark: boolean }>();
const emit = defineEmits<{
  logout: [];
  'toggle-theme': [];
}>();

const route = useRoute();
const router = useRouter();
const mobileOpen = ref(false);

const navItems = [
  { path: '/', label: 'Dashboard', icon: '📊' },
  { path: '/monitors/new', label: 'Add Monitor', icon: '➕' },
  { path: '/groups', label: 'Groups', icon: '📁' },
  { path: '/status-pages', label: 'Status Pages', icon: '🌐' },
  { path: '/notifications', label: 'Notifications', icon: '🔔' },
  { path: '/maintenance', label: 'Maintenance', icon: '🔧' },
  { path: '/settings', label: 'Settings', icon: '⚙️' },
];

function navigate(path: string) {
  router.push(path);
  mobileOpen.value = false;
}

// Expose mobileOpen toggle for parent
defineExpose({ toggleMobile: () => { mobileOpen.value = !mobileOpen.value; } });
</script>

<template>
  <!-- Mobile overlay -->
  <div v-if="mobileOpen" class="fixed inset-0 bg-black/50 z-40 lg:hidden" @click="mobileOpen = false"></div>

  <!-- Mobile top bar -->
  <div class="lg:hidden fixed top-0 left-0 right-0 z-30 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center px-4 h-14">
    <button @click="mobileOpen = true" class="p-2 -ml-2 text-gray-700 dark:text-gray-300">
      <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
    </button>
    <router-link to="/" class="flex items-center gap-2 ml-2">
      <span class="text-xl">🔍</span>
      <span class="font-bold text-gray-900 dark:text-white">Uptime Detective</span>
    </router-link>
  </div>

  <!-- Sidebar -->
  <aside :class="[
    'fixed lg:static inset-y-0 left-0 z-50 w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col transform transition-transform duration-200 ease-in-out',
    mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
  ]">
    <!-- Logo -->
    <div class="p-4 border-b border-gray-200 dark:border-gray-700">
      <router-link to="/" class="flex items-center gap-2" @click="mobileOpen = false">
        <span class="text-2xl">🔍</span>
        <h1 class="text-lg font-bold text-gray-900 dark:text-white">Uptime Detective</h1>
      </router-link>
    </div>

    <!-- Navigation -->
    <nav class="flex-1 p-4 space-y-1 overflow-y-auto">
      <a
        v-for="item in navItems"
        :key="item.path"
        @click="navigate(item.path)"
        class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer"
        :class="route.path === item.path
          ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'"
      >
        <span>{{ item.icon }}</span>
        <span>{{ item.label }}</span>
      </a>
    </nav>

    <!-- Footer -->
    <div class="p-4 border-t border-gray-200 dark:border-gray-700 space-y-2">
      <button
        @click="emit('toggle-theme')"
        class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      >
        <span>{{ isDark ? '☀️' : '🌙' }}</span>
        <span>{{ isDark ? 'Light Mode' : 'Dark Mode' }}</span>
      </button>
      <button
        @click="emit('logout')"
        class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
      >
        <span>🚪</span>
        <span>Logout</span>
      </button>
    </div>
  </aside>
</template>
