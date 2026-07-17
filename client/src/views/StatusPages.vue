<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useApi } from '../composables/useApi.js';

const api = useApi();
const pages = ref<any[]>([]);
const groups = ref<any[]>([]);
const monitors = ref<any[]>([]);
const loading = ref(true);

const showForm = ref(false);
const editingPage = ref<any>(null);
const form = ref({ title: '', description: '', logo_url: '', is_public: true });

const showItemModal = ref(false);
const activePageId = ref<number | null>(null);
const activePageItems = ref<any[]>([]);

async function fetchAll() {
  loading.value = true;
  try {
    pages.value = await api.get('/api/v1/status-pages');
    groups.value = await api.get('/api/v1/groups');
    monitors.value = await api.get('/api/v1/monitors');
  } catch {}
  finally { loading.value = false; }
}

function openCreate() {
  editingPage.value = null;
  form.value = { title: '', description: '', logo_url: '', is_public: true };
  showForm.value = true;
}

function openEdit(page: any) {
  editingPage.value = page;
  form.value = { title: page.title, description: page.description || '', logo_url: page.logo_url || '', is_public: Boolean(page.is_public) };
  showForm.value = true;
}

async function submitPage() {
  try {
    if (editingPage.value) {
      await api.put(`/api/v1/status-pages/${editingPage.value.id}`, form.value);
    } else {
      await api.post('/api/v1/status-pages', form.value);
    }
    showForm.value = false;
    await fetchAll();
  } catch {}
}

async function deletePage(id: number) {
  if (!confirm('Delete this status page?')) return;
  await api.del(`/api/v1/status-pages/${id}`);
  await fetchAll();
}

async function openItems(page: any) {
  activePageId.value = page.id;
  const full = await api.get<any>(`/api/v1/status-pages/${page.id}`);
  activePageItems.value = full.items || [];
  showItemModal.value = true;
}

async function addItem(type: 'group' | 'monitor', id: number) {
  if (!activePageId.value) return;
  const body = type === 'group' ? { group_id: id } : { monitor_id: id };
  await api.post(`/api/v1/status-pages/${activePageId.value}/items`, body);
  const full = await api.get<any>(`/api/v1/status-pages/${activePageId.value}`);
  activePageItems.value = full.items || [];
}

async function removeItem(itemId: number) {
  if (!activePageId.value) return;
  await api.del(`/api/v1/status-pages/${activePageId.value}/items/${itemId}`);
  activePageItems.value = activePageItems.value.filter(i => i.id !== itemId);
}

function getItemLabel(item: any): string {
  if (item.group_id) {
    const g = groups.value.find(g => g.id === item.group_id);
    return `📁 ${g?.name || `Group #${item.group_id}`}`;
  }
  const m = monitors.value.find(m => m.id === item.monitor_id);
  return `📡 ${m?.name || `Monitor #${item.monitor_id}`}`;
}

onMounted(fetchAll);
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Status Pages</h1>
      <button @click="openCreate" class="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 text-sm font-medium">+ New Page</button>
    </div>

    <!-- Create/Edit form -->
    <div v-if="showForm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showForm = false">
      <div class="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md shadow-xl">
        <h2 class="text-lg font-bold text-gray-900 dark:text-white mb-4">{{ editingPage ? 'Edit' : 'Create' }} Status Page</h2>
        <form @submit.prevent="submitPage" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title</label>
            <input v-model="form.title" required class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" placeholder="Service Status" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <textarea v-model="form.description" rows="2" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"></textarea>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Logo URL</label>
            <input v-model="form.logo_url" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" placeholder="https://..." />
          </div>
          <label class="flex items-center gap-2">
            <input type="checkbox" v-model="form.is_public" class="rounded" />
            <span class="text-sm text-gray-700 dark:text-gray-300">Public (accessible without auth)</span>
          </label>
          <div class="flex justify-end gap-2">
            <button type="button" @click="showForm = false" class="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg">Cancel</button>
            <button type="submit" class="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700">{{ editingPage ? 'Update' : 'Create' }}</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Items builder modal -->
    <div v-if="showItemModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showItemModal = false">
      <div class="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-lg shadow-xl max-h-[80vh] overflow-y-auto">
        <h2 class="text-lg font-bold text-gray-900 dark:text-white mb-4">Page Content</h2>

        <!-- Current items -->
        <div class="mb-4">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Current Items (in order)</h3>
          <div v-if="activePageItems.length === 0" class="text-sm text-gray-400 py-2">No items yet. Add groups or monitors below.</div>
          <div v-for="item in activePageItems" :key="item.id" class="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-700/50 rounded mb-1">
            <span class="text-sm">{{ getItemLabel(item) }}</span>
            <button @click="removeItem(item.id)" class="text-xs text-red-500 hover:text-red-700">✕ Remove</button>
          </div>
        </div>

        <!-- Add groups -->
        <div class="mb-4" v-if="groups.length > 0">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Add Group</h3>
          <div class="flex flex-wrap gap-2">
            <button v-for="g in groups" :key="g.id" @click="addItem('group', g.id)"
              class="px-3 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-primary-50 dark:hover:bg-primary-900/20">
              📁 {{ g.name }}
            </button>
          </div>
        </div>

        <!-- Add monitors -->
        <div>
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Add Individual Monitor</h3>
          <div class="flex flex-wrap gap-2">
            <button v-for="m in monitors" :key="m.id" @click="addItem('monitor', m.id)"
              class="px-3 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-primary-50 dark:hover:bg-primary-900/20">
              📡 {{ m.name }}
            </button>
          </div>
        </div>

        <div class="flex justify-end mt-4">
          <button @click="showItemModal = false" class="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700">Done</button>
        </div>
      </div>
    </div>

    <!-- Pages list -->
    <div v-if="loading" class="text-center py-12 text-gray-500">Loading...</div>
    <div v-else-if="pages.length === 0" class="text-center py-12 text-gray-500">
      <p>No status pages yet. Create one to share your uptime with the world.</p>
    </div>
    <div v-else class="grid gap-3">
      <div v-for="page in pages" :key="page.id" class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="font-medium text-gray-900 dark:text-white">{{ page.title }}</h3>
            <p class="text-sm text-gray-500">/status/{{ page.slug }}</p>
          </div>
          <div class="flex gap-2">
            <a :href="`/status/${page.slug}`" target="_blank" class="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700">🌐 View</a>
            <button @click="openItems(page)" class="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700">📋 Items</button>
            <button @click="openEdit(page)" class="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700">Edit</button>
            <button @click="deletePage(page.id)" class="px-3 py-1.5 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50">Delete</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
