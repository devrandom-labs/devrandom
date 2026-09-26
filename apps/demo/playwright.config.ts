import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:3213', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm run start --hostname 127.0.0.1 --port 3213',
    url: 'http://127.0.0.1:3213',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
