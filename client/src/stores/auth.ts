import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useApi } from '../composables/useApi.js';

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('token'));
  const user = ref<{ id: number; username: string; role: string } | null>(null);

  const isAuthenticated = computed(() => !!token.value);
  const api = useApi();

  async function login(username: string, password: string): Promise<void> {
    const response = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Login failed');
    }

    const data = await response.json();
    token.value = data.token;
    user.value = data.user;
    localStorage.setItem('token', data.token);
  }

  function logout(): void {
    token.value = null;
    user.value = null;
    localStorage.removeItem('token');
  }

  async function fetchUser(): Promise<void> {
    if (!token.value) return;
    try {
      const response = await fetch('/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${token.value}` },
      });
      if (response.ok) {
        user.value = await response.json();
      } else {
        logout();
      }
    } catch {
      logout();
    }
  }

  return { token, user, isAuthenticated, login, logout, fetchUser };
});
