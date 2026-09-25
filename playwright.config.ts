import { defineConfig, devices } from '@playwright/test';

/**
 * The UI tests run against the real local service and the real Vite build. The chain-dependent
 * endpoints are stubbed per test; the wallet is an injected provider stub that records whatever
 * the page asked it to sign, so the tests can prove the rendered mandate is the signed mandate.
 */
export default defineConfig({
  testDir: 'tests/ui',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    actionTimeout: 10_000,
    baseURL: 'http://127.0.0.1:5173',
    trace: 'off',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'corepack pnpm@10.17.1 exec tsx services/api/src/server.ts',
      url: 'http://127.0.0.1:8787/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        CROSSFLOW_PORT: '8787',
        // The suite makes many more requests than an interactive operator would.
        CROSSFLOW_RATE_LIMIT: '2000',
      },
    },
    {
      command: 'corepack pnpm@10.17.1 exec vite --config vite.config.ts --port 5173',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
