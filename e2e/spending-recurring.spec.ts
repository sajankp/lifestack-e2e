import { execSync } from 'child_process';
import { test, expect } from '@playwright/test';

function triggerRecurringJob() {
  const env = { ...process.env };
  if (process.env.E2E_DATABASE_URL) {
    env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  }
  // Trigger the background recurring job directly on the host using the CLI
  execSync(
    'uv run python -c "import asyncio; from app.application.jobs import recurring_transactions_job; asyncio.run(recurring_transactions_job())"',
    { cwd: '../lifestack-api', env }
  );
}

test.describe('Spending Recurring Transactions E2E Flow', () => {
  const timestamp = Date.now();
  const testEmail = `e2e-recurring-${timestamp}@example.com`;
  const testUsername = `e2e_recurring_${timestamp}`;
  const testPassword = 'Password123!';
  const ruleDescription = `Netflix Sub ${timestamp}`;

  test.beforeEach(async ({ page, baseURL }) => {
    // Register and login a fresh user for this test file
    await page.goto('/register');
    await page.fill('input[placeholder="Email address"]', testEmail);
    await page.fill('input[placeholder="Username"]', testUsername);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button[type="submit"]');

    await page.goto('/login');
    await page.fill('input[placeholder="Email address"]', testEmail);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(`${baseURL}/`, { timeout: 10000 });
  });

  test('should create, edit, run generation, and deactivate a recurring rule', async ({ page }) => {
    // 1. Navigate to Spending page
    await page.click('a[href="/spending"]');
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();

    // 2. Click Recurring Tab and add a new rule
    await page.getByRole('button', { name: 'Recurring', exact: true }).click();
    await page.getByRole('button', { name: 'Add Recurring', exact: true }).click();

    // 3. Fill Recurring Rule modal
    await page.locator('form').getByRole('button', { name: 'Select category' }).click();
    await page.click('role=option[name="Food & Dining"]');

    // Amount
    await page.fill('input[id="rec-amount"]', '14.99');

    // Type is expense by default (which we want)

    // Frequency: Select Monthly
    await page.locator('form').getByRole('button', { name: 'Monthly' }).click();
    await page.click('role=option[name="Monthly"]');

    // Start Date (anchor_date): Use today
    const todayStr = new Date().toISOString().split('T')[0];
    await page.fill('input[id="rec-anchor"]', todayStr);

    // Description
    await page.fill('input[id="rec-desc"]', ruleDescription);

    // Click Create Rule
    await page.click('button[type="submit"]:has-text("Create Rule")');

    // 4. Verify rule card is visible in the list
    await expect(page.locator(`text=${ruleDescription}`)).toBeVisible();
    await expect(page.locator(`text=$14.99`)).toBeVisible();

    // 5. Edit the rule
    await page.click('button:has-text("Edit")');
    await page.fill('input[id="rec-amount"]', '19.99');
    await page.click('button[type="submit"]:has-text("Update Rule")');

    // Verify updated amount is visible
    await expect(page.locator(`text=$19.99`)).toBeVisible();

    // 6. Run the background job to generate the transaction
    triggerRecurringJob();
    await page.reload();

    // 7. Verify transaction was generated under the Transactions tab
    await page.getByRole('button', { name: 'Transactions', exact: true }).click();
    await expect(page.locator(`text=${ruleDescription}`)).toBeVisible();
    await expect(page.locator('tbody').locator('text=19.99')).toBeVisible();

    // 8. Go back to Recurring tab and deactivate the rule
    await page.getByRole('button', { name: 'Recurring', exact: true }).click();
    await page.click('button:has-text("Deactivate")');

    // Verify list is empty or doesn't show the active rule anymore
    await expect(page.locator(`text=${ruleDescription}`)).not.toBeVisible();
  });
});
