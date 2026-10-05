import { defineConfig } from 'vitest/config';

// Web-only test run (`npm test -w @pm/web`). The root config also picks these files up.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
