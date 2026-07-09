import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { registerAndLogin } from './helpers/auth';
import { retryUnauthorized } from './helpers/api';

const PLAYWRIGHT_API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8000';
const API_BASE = PLAYWRIGHT_API_URL.endsWith('/v1') ? PLAYWRIGHT_API_URL : `${PLAYWRIGHT_API_URL}/v1`;

type ApiMedication = { public_id: string; name: string };

async function csrfHeaders(page: Page) {
  const state = await page.context().storageState();
  const csrfCookie = state.cookies.find((cookie) => cookie.name === 'csrf_token');
  expect(csrfCookie, 'CSRF token cookie should be defined').toBeDefined();
  const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';

  return {
    Origin: origin,
    Referer: `${origin}/`,
    ...(csrfCookie ? { 'X-CSRF-Token': csrfCookie.value } : {}),
  };
}

async function createMedicationViaApi(
  page: Page,
  data: Record<string, unknown>,
): Promise<ApiMedication> {
  const response = await retryUnauthorized(async () =>
    page.request.post(`${API_BASE}/health/medications`, {
      headers: await csrfHeaders(page),
      data,
    }),
  );
  expect(response.status(), `Medication creation failed: ${await response.text()}`).toBe(201);
  return (await response.json()) as ApiMedication;
}

test.describe('Health Memory Flow', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-health-${uniqueId}@example.com`;
    testUsername = `e2e_health_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('creates a medication, resolves missed + pending dose chips, logs a dose and a weight, and surfaces in the briefing @smoke', async ({
    page,
  }) => {
    const medName = `Smoke Med ${Date.now()}`;
    const today = new Date().toISOString().slice(0, 10);

    // One slot deep in the past-grace window (00:05 UTC — reads as "missed"
    // unless the suite runs in the first few minutes after UTC midnight) and
    // one still upcoming (23:55 UTC) — the spec's test plan calls for both a
    // missed and a pending chip in the same run.
    const medication = await createMedicationViaApi(page, {
      name: medName,
      dose_text: '1 tablet',
      frequency: 'daily',
      interval: 1,
      anchor_date: today,
      timezone: 'UTC',
      times: ['00:05', '23:55'],
    });

    await page.getByTestId('nav-health').click();
    await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible();

    const missedRow = page.locator(
      `[data-testid^="dose-slot-${medication.public_id}-"][data-status="missed"]`,
    );
    const pendingRow = page.locator(
      `[data-testid^="dose-slot-${medication.public_id}-"][data-status="pending"]`,
    );
    await expect(missedRow).toBeVisible();
    await expect(pendingRow).toBeVisible();

    const eventPromise = page.waitForResponse(
      (res) => res.url().includes(`/v1/health/medications/${medication.public_id}/events`) && res.request().method() === 'PUT',
    );
    await pendingRow.getByRole('button', { name: `Mark ${medName} taken` }).click();
    const eventResponse = await eventPromise;
    expect(eventResponse.ok()).toBeTruthy();

    await expect(
      page.locator(`[data-testid^="dose-slot-${medication.public_id}-"][data-status="taken"]`),
    ).toBeVisible();

    const weightPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/health/weight') && res.request().method() === 'POST',
    );
    await page.getByTestId('weight-quick-log-input').fill('72.4');
    await page.getByTestId('weight-quick-log-submit').click();
    await weightPromise;

    await expect(page.getByText('72.4 kg')).toBeVisible();

    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('dashboard-briefing')).toBeVisible();
    const healthLine = page.getByTestId('dashboard-briefing-line').filter({ hasText: 'dose' });
    await expect(healthLine.first()).toBeVisible();
  });
});
