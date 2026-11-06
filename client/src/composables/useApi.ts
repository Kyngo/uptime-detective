import { useAuthStore } from '../stores/auth.js';

export function useApi() {
  function getHeaders(): Record<string, string> {
    const auth = useAuthStore();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (auth.token) {
      headers['Authorization'] = `Bearer ${auth.token}`;
    }
    return headers;
  }

  async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: { ...getHeaders(), ...options.headers as Record<string, string> },
    });

    if (response.status === 401) {
      const auth = useAuthStore();
      auth.logout();
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      // Some endpoints (e.g. Telegram) answer errors with { message }.
      throw new Error(error.error || error.message || `HTTP ${response.status}`);
    }

    // Tolerate empty/204 responses from endpoints that return no body.
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    get: <T>(url: string) => request<T>(url),
    post: <T>(url: string, body: any) => request<T>(url, { method: 'POST', body: JSON.stringify(body) }),
    put: <T>(url: string, body: any) => request<T>(url, { method: 'PUT', body: JSON.stringify(body) }),
    del: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
  };
}
