import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Run test files sequentially so Neon test-branch tables never race on reset.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
