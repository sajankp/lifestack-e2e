import { type Page } from '@playwright/test';

type AuthCredentials = {
  email: string;
  username: string;
  password: string;
};

const RATE_LIMIT_TEXT = 'Rate limit exceeded';
const TOO_MANY_REQUESTS_TEXT = 'Too many requests';
const RATE_LIMIT_BACKOFF_MS = 65_000;
const MAX_AUTH_ATTEMPTS = 3;
const TRANSIENT_RETRY_DELAY_MS = 1_500;

export async function registerAndLogin(
  page: Page,
  baseURL: string | undefined,
  credentials: AuthCredentials,
): Promise<void> {
  await registerWithBackoff(page, credentials);
  await loginWithBackoff(page, baseURL, credentials);
}

async function registerWithBackoff(page: Page, credentials: AuthCredentials): Promise<void> {
  for (let attempt = 0; attempt < MAX_AUTH_ATTEMPTS; attempt += 1) {
    await page.goto('/register');
    await page.fill('input[placeholder="Email address"]', credentials.email);
    await page.fill('input[placeholder="Username"]', credentials.username);
    await page.fill('input[placeholder="Password"]', credentials.password);
    await page.click('button[type="submit"]');

    const redirectedToLogin = await page
      .waitForURL(/.*\/login/, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    if (redirectedToLogin) {
      return;
    }

    const rateLimited =
      (await page.locator(`text=${RATE_LIMIT_TEXT}`).isVisible()) ||
      (await page.locator(`text=${TOO_MANY_REQUESTS_TEXT}`).isVisible());
    if (attempt < MAX_AUTH_ATTEMPTS - 1) {
      await page.waitForTimeout(rateLimited ? RATE_LIMIT_BACKOFF_MS : TRANSIENT_RETRY_DELAY_MS);
      continue;
    }

    throw new Error('Registration did not complete successfully.');
  }
}

async function loginWithBackoff(
  page: Page,
  baseURL: string | undefined,
  credentials: AuthCredentials,
): Promise<void> {
  const resolvedBaseURL = baseURL || 'http://localhost:5173';

  for (let attempt = 0; attempt < MAX_AUTH_ATTEMPTS; attempt += 1) {
    await page.goto('/login');
    await page.fill('input[placeholder="Email address"]', credentials.email);
    await page.fill('input[placeholder="Password"]', credentials.password);
    await page.click('button[type="submit"]');

    const landedOnDashboard = await page
      .waitForURL(`${resolvedBaseURL}/`, { timeout: 10000 })
      .then(() => true)
      .catch(() => false);

    if (landedOnDashboard) {
      return;
    }

    const rateLimited =
      (await page.locator(`text=${RATE_LIMIT_TEXT}`).isVisible()) ||
      (await page.locator(`text=${TOO_MANY_REQUESTS_TEXT}`).isVisible());
    if (attempt < MAX_AUTH_ATTEMPTS - 1) {
      await page.waitForTimeout(rateLimited ? RATE_LIMIT_BACKOFF_MS : TRANSIENT_RETRY_DELAY_MS);
      continue;
    }

    throw new Error('Login did not complete successfully.');
  }
}
