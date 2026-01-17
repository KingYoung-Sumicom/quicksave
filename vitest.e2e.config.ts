import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.e2e.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run in main thread to avoid issues with WebSocket
    fileParallelism: false,
    sequence: {
      shuffle: false,
    },
  },
});
