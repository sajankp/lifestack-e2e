import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.describe('Authentication and User Registration Flow', () => {
  const testPassword = 'Password123!';

  test('should register, login, and logout successfully @smoke @critical', async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    const testEmail = `e2e-user-${uniqueId}@example.com`;
    const testUsername = `e2euser_${uniqueId.replace(/-/g, '_')}`;
    page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text(), msg.type()));
    page.on('requestfailed', req => console.log('BROWSER REQUEST FAILED:', req.url(), req.failure()?.errorText));

    // 1. Visit Login page
    await page.goto('/login');
    await expect(page.locator('h2')).toContainText('Lifestack');

    // 2. Navigate to Register page
    await page.click('text=Create one');
    await expect(page).toHaveURL(/.*\/register/);

    // 3. Register user
    let redirectedToLogin = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await page.goto('/register');
        await expect(page).toHaveURL(/.*\/register/);
      }

      await page.fill('input[placeholder="Email address"]', testEmail);
      await page.fill('input[placeholder="Username"]', testUsername);
      await page.fill('input[placeholder="Password"]', testPassword);
      const registerResponsePromise = page.waitForResponse(
        (response) => response.url().includes('/auth/register') && response.request().method() === 'POST',
      );
      await page.click('button[type="submit"]');
      const registerResponse = await registerResponsePromise;

      if (registerResponse.ok()) {
        await expect(page).toHaveURL(/.*\/login/, { timeout: 15000 });
        redirectedToLogin = true;
      }

      if (redirectedToLogin) break;

      const rateLimited =
        registerResponse.status() === 429 ||
        (await page.locator('text=Rate limit exceeded').isVisible()) ||
        (await page.locator('text=Too many requests').isVisible());
      if (rateLimited && attempt < 2) {
        const retryAfter = Number(registerResponse.headers()['retry-after']);
        await delay(Number.isFinite(retryAfter) ? Math.max(1500, retryAfter * 1000) : 5000);
        continue;
      }
      break;
    }

    // 4. Verify redirected to login with success message
    expect(redirectedToLogin).toBeTruthy();
    await expect(page).toHaveURL(/.*\/login/, { timeout: 10000 });
    await expect(page.locator('text=Registration successful')).toBeVisible();

    // 5. Log in
    await page.fill('input[placeholder="Email address"]', testEmail);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button[type="submit"]');

    // 6. Verify dashboard access
    await expect(page).toHaveURL(`${baseURL}/`, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // 7. Log out (logout now lives inside the profile dropdown menu)
    await page.getByTestId('header-profile-menu').click();
    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/.*\/login/);

    // 8. Try accessing protected page while logged out
    await page.goto('/');
    await expect(page).toHaveURL(/.*\/login/);
  });
});
