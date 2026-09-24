import { defineConfig } from 'vitest/config';

/**
 * Vitest gets its own config because `vite.config.ts` roots the *web app* at `apps/web`. Test
 * paths are repository-relative, and the Playwright specs are excluded because they need a browser.
 */
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/ui/**', '**/node_modules/**'],
    environment: 'node',
  },
});
