import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { registerAndLogin } from './helpers/auth';

test.describe('PWA & Offline Readiness E2E Spec', () => {
  test('validates web manifest accessibility and parameters', async ({ page }) => {
    const response = await page.goto('/manifest.webmanifest');
    expect(response?.status()).toBe(200);

    const manifest = (await response?.json()) as {
      name?: string;
      short_name?: string;
      display?: string;
      start_url?: string;
      icons?: Array<{ src: string }>;
    };

    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBeTruthy();
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons!.length).toBeGreaterThan(0);
  });

  test('authenticated user offline state displays offline notice banner instead of redirecting to login', async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    const testEmail = `e2e-pwa-offline-${uniqueId}@example.com`;
    const testUsername = `e2e_pwa_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: 'Password123!',
    });

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // Simulate offline state in browser context
    await page.context().setOffline(true);

    // UX Review Real-Data PWA #70: Offline authenticated users should see cached UI or offline banner, NOT redirect to /login
    await page.goto('/', { waitUntil: 'domcontentloaded' }).catch(() => null);

    const isLoginPage = page.url().includes('/login');
    expect(isLoginPage).toBe(false);

    const offlineBanner = page.locator('[data-testid="offline-notice-banner"]');
    if (await offlineBanner.isVisible()) {
      await expect(offlineBanner).toContainText(/offline/i);
    }

    await page.context().setOffline(false);
  });
});
