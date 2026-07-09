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
    const utcHour = new Date().getUTCHours();
    let offset = 12 - utcHour;
    if (offset < -11) offset += 24;
    if (offset > 12) offset -= 24;

    const timezones: Record<number, string> = {
      [-11]: 'Pacific/Midway',
      [-10]: 'Pacific/Honolulu',
      [-9]: 'America/Anchorage',
      [-8]: 'America/Los_Angeles',
      [-7]: 'America/Denver',
      [-6]: 'America/Chicago',
      [-5]: 'America/New_York',
      [-4]: 'America/Halifax',
      [-3]: 'America/Argentina/Buenos_Aires',
      [-2]: 'America/Noronha',
      [-1]: 'Atlantic/Cape_Verde',
      [0]: 'UTC',
      [1]: 'Africa/Lagos',
      [2]: 'Africa/Johannesburg',
      [3]: 'Asia/Riyadh',
      [4]: 'Asia/Dubai',
      [5]: 'Asia/Karachi',
      [6]: 'Asia/Dhaka',
      [7]: 'Asia/Bangkok',
      [8]: 'Asia/Singapore',
      [9]: 'Asia/Tokyo',
      [10]: 'Australia/Sydney',
      [11]: 'Pacific/Guadalcanal',
      [12]: 'Pacific/Auckland',
    };
    const tz = timezones[offset] || 'UTC';
    const anchorDate = new Date().toLocaleDateString('en-CA', { timeZone: tz });

    // We choose a timezone where the current time is exactly 12:00 PM (noon).
    // This allows us to set one slot 6 hours in the past (06:00, which is missed)
    // and one slot 6 hours in the future (18:00, which is pending) on the same date,
    // making the test completely robust against the time of day.
    const medication = await createMedicationViaApi(page, {
      name: medName,
      dose_text: '1 tablet',
      frequency: 'daily',
      interval: 1,
      anchor_date: anchorDate,
      timezone: tz,
      times: ['06:00', '18:00'],
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

    await pendingRow.getByRole('button', { name: `Mark ${medName} taken` }).click();

    await expect(
      page.locator(`[data-testid^="dose-slot-${medication.public_id}-"][data-status="taken"]`),
    ).toBeVisible();

    await page.getByTestId('weight-quick-log-input').fill('72.4');
    await page.getByTestId('weight-quick-log-submit').click();

    await expect(page.getByText('72.4 kg')).toBeVisible();

    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('dashboard-briefing')).toBeVisible();
    const healthLine = page.getByTestId('dashboard-briefing-line').filter({ hasText: 'dose' });
    await expect(healthLine.first()).toBeVisible();
  });
});
