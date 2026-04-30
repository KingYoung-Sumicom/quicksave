// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // Multiple test files spawn real `claude` child processes (messageHandler.edge,
    // sessionManager, edgeCases, codexSdkProvider). Running them in parallel causes
    // CPU contention so init handshakes exceed the default 5s test timeout.
    // Serializing files keeps real-spawn tests reliable without masking the timeout.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
});
