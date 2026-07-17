import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

// Cached setup status to avoid repeated API calls during navigation
let setupStatusChecked = false;
let needsSetup = false;

async function checkSetupStatus(): Promise<boolean> {
  if (setupStatusChecked) return needsSetup;

  try {
    const response = await fetch('/api/v1/setup/status');
    if (response.ok) {
      const data = await response.json();
      needsSetup = data.needsSetup;
    }
  } catch {
    // If we can't reach the API, don't block navigation
    needsSetup = false;
  }

  setupStatusChecked = true;
  return needsSetup;
}

// Allow resetting the cache (used after setup completes)
export function resetSetupStatus(): void {
  setupStatusChecked = false;
  needsSetup = false;
}

const routes = [
  {
    path: '/setup',
    name: 'setup',
    component: () => import('../views/SetupWizard.vue'),
    meta: { setup: true },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/Login.vue'),
    meta: { guest: true },
  },
  {
    path: '/',
    name: 'dashboard',
    component: () => import('../views/Dashboard.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/monitors/new',
    name: 'monitor-create',
    component: () => import('../views/MonitorForm.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/monitors/:id/edit',
    name: 'monitor-edit',
    component: () => import('../views/MonitorForm.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/monitors/:id',
    name: 'monitor-detail',
    component: () => import('../views/MonitorDetail.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/groups',
    name: 'groups',
    component: () => import('../views/Groups.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/status-pages',
    name: 'status-pages',
    component: () => import('../views/StatusPages.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/notifications',
    name: 'notifications',
    component: () => import('../views/Notifications.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/maintenance',
    name: 'maintenance',
    component: () => import('../views/Maintenance.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/Settings.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/status/:slug',
    name: 'public-status',
    component: () => import('../views/PublicStatusPage.vue'),
    meta: { public: true }, // No auth required, no sidebar
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Navigation guard
router.beforeEach(async (to, _from, next) => {
  const auth = useAuthStore();

  // Public pages (status pages) are always accessible
  if (to.meta.public) {
    next();
    return;
  }

  // Check if setup is needed
  const setupRequired = await checkSetupStatus();

  if (setupRequired) {
    // If setup is needed, only allow the setup page
    if (to.meta.setup) {
      next();
    } else {
      next({ name: 'setup' });
    }
    return;
  }

  // Setup is complete — don't allow visiting setup page again
  if (to.meta.setup) {
    next({ name: 'dashboard' });
    return;
  }

  // Normal auth flow
  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    next({ name: 'login' });
  } else if (to.meta.guest && auth.isAuthenticated) {
    next({ name: 'dashboard' });
  } else {
    next();
  }
});
