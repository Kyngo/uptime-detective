import { ref, watch, onMounted } from 'vue';

const isDark = ref(false);

export function useTheme() {
  function init() {
    const stored = localStorage.getItem('theme');
    if (stored === 'dark') {
      isDark.value = true;
    } else if (stored === 'light') {
      isDark.value = false;
    } else {
      // System preference
      isDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    applyTheme();
  }

  function toggle() {
    isDark.value = !isDark.value;
    localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
    applyTheme();
  }

  function applyTheme() {
    if (isDark.value) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }

  return { isDark, toggle, init };
}
