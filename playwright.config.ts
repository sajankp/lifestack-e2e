import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // Run sequentially to avoid database race conditions
  timeout: 120_000,
  retries: 1,
  // CI gate (Task 4): 'html' produces the playwright-report/ directory the
  // CI workflow uploads as an artifact on failure; 'list' keeps the terminal
  // output readable both locally and in Action logs.
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    timezoneId: 'UTC',
    extraHTTPHeaders: {
      'Origin': process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
