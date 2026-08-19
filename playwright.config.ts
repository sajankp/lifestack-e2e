import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // Run sequentially for database isolation to prevent race conditions and state conflicts across tests
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
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
    extraHTTPHeaders: {
      'Origin': process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174',
      'X-Playwright-API-Base': process.env.PLAYWRIGHT_API_URL || 'http://localhost:8001',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
