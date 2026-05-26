import { execSync } from 'child_process';
import { test, expect } from '@playwright/test';

function triggerBudgetGuardrails() {
  const env = { ...process.env };
  if (process.env.E2E_DATABASE_URL) {
    env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  }
  // Trigger the background guardrails job directly on the host using the CLI
  execSync(
    'uv run python -c "import asyncio; from app.application.jobs import budget_guardrails_job; asyncio.run(budget_guardrails_job())"',
    { cwd: '../lifestack-api', env }
  );
}

test.describe('Spending Tracker & Budget Guardrails E2E Flow', () => {
  const timestamp = Date.now();
  const testEmail = `e2e-spending-${timestamp}@example.com`;
  const testUsername = `e2e_spending_${timestamp}`;
  const testPassword = 'Password123!';
  const customCategory = `Dining Out ${timestamp}`;

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

  test('should create custom category, set budget, log transaction, and trigger warning todo', async ({ page }) => {
    // 1. Navigate to Spending tab
    await page.click('a[href="/spending"]');
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();

    // 2. Open Manage Categories and add a custom category
    await page.click('button:has-text("Manage Categories")');
    await page.fill('input[placeholder="e.g. Groceries"]', customCategory);
    await page.fill('input[placeholder="🧾"]', '🍔');
    await page.click('button[type="submit"]:has-text("Create Category")');

    // 3. Set a budget for the custom category
    await page.click('button:has-text("Set Budget")');
    await page.click('button[aria-haspopup="listbox"]:has-text("Select category")');
    await page.click(`role=option[name="${customCategory}"]`);
    await page.fill('input[placeholder="0.00"]', '100');
    await page.click('button[type="submit"]:has-text("Save Budget")');

    // Verify budget card is created
    await page.click('button:has-text("Budgets")');
    await expect(page.locator(`text=${customCategory}`)).toBeVisible();

    // 4. Log a transaction breaching warning threshold (95%)
    await page.click('button:has-text("New Transaction")');
    await page.fill('form input[type="number"][placeholder="0.00"]', '95');
    await page.click('form button[aria-haspopup="listbox"]:has-text("Select category")');
    await page.click(`role=option[name="${customCategory}"]`);
    await page.fill('input[placeholder="What did you spend on?"]', 'E2E Feast');
    await page.click('button[type="submit"]:has-text("Save Transaction")');

    // Verify transaction appears in the list
    await page.click('button:has-text("Transactions")');
    await expect(page.locator('text=E2E Feast')).toBeVisible();

    // 5. Trigger the background budget guardrails evaluator
    triggerBudgetGuardrails();

    // 6. Navigate to Todo page and verify warning todo exists
    await page.click('a[href="/todo"]');
    await expect(page.getByRole('heading', { name: 'Todos' })).toBeVisible();
    await expect(page.locator(`text=[Budget] Warning: ${customCategory}`)).toBeVisible();
  });
});
