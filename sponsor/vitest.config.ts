import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'sponsor',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
