import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { bootstrapTelegramWebApp } from './telegram-webapp.js';
import './assets/tailwind.css';

async function start(): Promise<void> {
  // When opened as a Telegram Mini App, sign in with the signed init data first so
  // the auth store has a token before the app and router mount.
  await bootstrapTelegramWebApp();

  // Import the router only after the bootstrap: `createWebHistory()` caches the
  // current URL, so it must see the URL with tgWebAppData already removed.
  const { router } = await import('./router/index.js');

  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.mount('#app');
}

void start();
