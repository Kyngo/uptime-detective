<script setup lang="ts">
import { onMounted, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useTheme } from './composables/useTheme.js';
import { useSocket } from './composables/useSocket.js';
import AppSidebar from './components/AppSidebar.vue';

const auth = useAuthStore();
const { isDark, toggle, init: initTheme } = useTheme();
const { connect } = useSocket();
const router = useRouter();
const route = useRoute();

const isPublicRoute = computed(() => route.meta.public === true);
const isSetupRoute = computed(() => route.meta.setup === true);

onMounted(async () => {
  initTheme();
  if (auth.isAuthenticated) {
    await auth.fetchUser();
    connect();
  }
});

function handleLogout() {
  auth.logout();
  router.push('/login');
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-900 transition-colors">
    <!-- Public layout (status pages) -->
    <div v-if="isPublicRoute">
      <router-view />
    </div>

    <!-- Setup wizard layout -->
    <div v-else-if="isSetupRoute">
      <router-view />
    </div>

    <!-- Authenticated layout -->
    <div v-else-if="auth.isAuthenticated" class="flex h-screen overflow-hidden">
      <AppSidebar @logout="handleLogout" :is-dark="isDark" @toggle-theme="toggle" />
      <main class="flex-1 overflow-y-auto p-6 pt-20 lg:pt-6">
        <router-view />
      </main>
    </div>

    <!-- Guest layout (login) -->
    <div v-else>
      <router-view />
    </div>
  </div>
</template>
