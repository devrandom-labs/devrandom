import { defineConfig } from '@playwright/test';

export default defineConfig({
  fullyParallel: false,
  outputDir: process.env.DEVRANDOM_PLAYWRIGHT_OUTPUT_DIR ?? '.playwright-artifacts',
  reporter: 'line',
  testDir: './e2e',
  timeout: 180_000,
  use: {
    headless: true,
    trace: 'off',
  },
  workers: 1,
});
