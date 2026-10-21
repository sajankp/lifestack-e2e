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
    // The app registers a service worker (public/sw.js) that controls the
    // page. Even though it returns early for cross-origin /v1/ API calls,
    // the worker still intercepts them, and Playwright does not attribute
    // a service-worker-handled response to the page -- so
    // page.waitForResponse() for an API call never resolves, while the
    // request itself succeeds. Blocking the worker makes API responses
    // observable again.
    serviceWorkers: 'block',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    timezoneId: 'UTC',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
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
