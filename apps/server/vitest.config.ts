import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/globalSetup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Suites share one MongoDB and Redis, each with its own database name and key prefix.
    fileParallelism: false,
  },
});
