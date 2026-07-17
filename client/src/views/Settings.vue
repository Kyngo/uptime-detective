<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useApi } from '../composables/useApi.js';
import { useAuthStore } from '../stores/auth.js';

const api = useApi();
const auth = useAuthStore();

const apiToken = ref<string | null>(null);
const currentPassword = ref('');
const newPassword = ref('');
const passwordMsg = ref('');
const passwordError = ref('');
const tokenMsg = ref('');

onMounted(async () => {
  const user = await api.get<any>('/api/v1/auth/me');
  apiToken.value = user.api_token;
});

async function generateToken() {
  const result = await api.post<any>('/api/v1/auth/api-token', {});
  apiToken.value = result.api_token;
  tokenMsg.value = 'Token generated! Copy it now — it won\'t be shown again.';
  setTimeout(() => tokenMsg.value = '', 5000);
}

async function revokeToken() {
  await api.del('/api/v1/auth/api-token');
  apiToken.value = null;
  tokenMsg.value = 'Token revoked.';
  setTimeout(() => tokenMsg.value = '', 3000);
}

function copyToken() {
  if (apiToken.value) navigator.clipboard.writeText(apiToken.value);
}

async function changePassword() {
  passwordMsg.value = '';
  passwordError.value = '';
  try {
    await api.put('/api/v1/auth/password', { current_password: currentPassword.value, new_password: newPassword.value });
    passwordMsg.value = 'Password updated successfully.';
    currentPassword.value = '';
    newPassword.value = '';
  } catch (err: any) { passwordError.value = err.message; }
}
</script>

<template>
  <div class="max-w-2xl">
    <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-6">Settings</h1>

    <!-- API Token -->
    <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 mb-6">
      <h2 class="font-semibold text-gray-900 dark:text-white mb-3">API Token</h2>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">Use this token to authenticate with the public API. Include it as <code class="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-xs">Bearer &lt;token&gt;</code> in the Authorization header.</p>

      <div v-if="tokenMsg" class="mb-3 p-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded text-green-700 dark:text-green-400 text-sm">{{ tokenMsg }}</div>

      <div v-if="apiToken" class="mb-4">
        <div class="flex items-center gap-2">
          <code class="flex-1 px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded text-sm font-mono text-gray-900 dark:text-white break-all">{{ apiToken }}</code>
          <button @click="copyToken" class="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700">📋</button>
        </div>
      </div>

      <div class="flex gap-2">
        <button @click="generateToken" class="px-3 py-2 text-sm bg-primary-600 text-white rounded hover:bg-primary-700">{{ apiToken ? 'Regenerate' : 'Generate Token' }}</button>
        <button v-if="apiToken" @click="revokeToken" class="px-3 py-2 text-sm border border-red-300 text-red-600 rounded hover:bg-red-50">Revoke</button>
      </div>
    </div>

    <!-- Change Password -->
    <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
      <h2 class="font-semibold text-gray-900 dark:text-white mb-3">Change Password</h2>

      <div v-if="passwordMsg" class="mb-3 p-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded text-green-700 dark:text-green-400 text-sm">{{ passwordMsg }}</div>
      <div v-if="passwordError" class="mb-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-red-700 dark:text-red-400 text-sm">{{ passwordError }}</div>

      <form @submit.prevent="changePassword" class="space-y-3">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Current Password</label>
          <input v-model="currentPassword" type="password" required class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">New Password</label>
          <input v-model="newPassword" type="password" required minlength="6" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
        </div>
        <button type="submit" class="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700">Update Password</button>
      </form>
    </div>
  </div>
</template>
