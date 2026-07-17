import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: '.',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/db/migrate.ts', 'src/db/seed.ts'],
    },
    // Each test file gets its own isolated module context
    isolate: true,
  },
  resolve: {
    alias: {
      '@uptime-detective/shared': '../shared/src/index.ts',
    },
  },
});
