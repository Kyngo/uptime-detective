<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useSocket } from '../composables/useSocket.js';

const router = useRouter();
const auth = useAuthStore();
const { connect } = useSocket();

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function handleLogin() {
  error.value = '';
  loading.value = true;
  try {
    await auth.login(username.value, password.value);
    connect();
    router.push('/');
  } catch (err: any) {
    error.value = err.message || 'Login failed';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <span class="text-4xl">🔍</span>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white mt-2">Uptime Detective</h1>
        <p class="text-gray-500 dark:text-gray-400 mt-1">Sign in to your dashboard</p>
      </div>

      <form @submit.prevent="handleLogin" class="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 space-y-4">
        <div v-if="error" class="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm">
          {{ error }}
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
          <input v-model="username" type="text" required autofocus
            class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            placeholder="admin" />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
          <input v-model="password" type="password" required
            class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            placeholder="••••••••" />
        </div>

        <button type="submit" :disabled="loading"
          class="w-full py-2 px-4 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors">
          {{ loading ? 'Signing in...' : 'Sign In' }}
        </button>
      </form>

      <p class="text-center text-xs text-gray-400 mt-4">Default credentials: admin / admin</p>
    </div>
  </div>
</template>
