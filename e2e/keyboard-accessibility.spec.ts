import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

async function tabUntilTestId(page: Page, testId: string, maxTabs = 40): Promise<void> {
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press('Tab');
    const focusedTestId = await page.evaluate(() => {
      const active = document.activeElement;
      return active?.closest('[data-testid]')?.getAttribute('data-testid') ?? null;
    });

    if (focusedTestId === testId) {
      return;
    }
  }

  throw new Error(`Unable to focus [data-testid="${testId}"] with Tab`);
}

test.describe('Keyboard accessibility E2E Flow', () => {
  test('supports keyboard navigation through sidebar and Todo creation/completion', async ({
    page,
    baseURL,
  }) => {
    const uniqueId = randomUUID();
    const credentials = {
      email: `e2e-keyboard-${uniqueId}@example.com`,
      username: `e2e_keyboard_${uniqueId.replace(/-/g, '_').slice(0, 24)}`,
      password: 'Password123!',
    };
    const todoTitle = `Keyboard task ${uniqueId.slice(0, 8)}`;

    await registerAndLogin(page, baseURL, credentials);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await tabUntilTestId(page, 'nav-todo');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Todos' })).toBeVisible();

    // Focus and press Enter on the "Add Task" button to open the modal
    await page.getByRole('button', { name: 'Add Task' }).focus();
    await page.keyboard.press('Enter');

    await tabUntilTestId(page, 'todo-new-title');
    await page.keyboard.insertText(todoTitle);
    await tabUntilTestId(page, 'todo-new-submit');

    const createPromise = page.waitForResponse(
      (response) =>
        response.url().includes('/v1/todo/') &&
        response.request().method() === 'POST',
    );
    await page.keyboard.press('Enter');
    const createResponse = await createPromise;
    expect(createResponse.status()).toBe(201);
    const todo = (await createResponse.json()) as { public_id: string };

    await expect(page.getByText(todoTitle)).toBeVisible();

    const toggleTestId = `todo-toggle-${todo.public_id}`;
    await tabUntilTestId(page, toggleTestId);
    const completePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/todo/${todo.public_id}`) &&
        response.request().method() === 'PATCH',
    );
    await page.keyboard.press('Space');
    const completeResponse = await completePromise;
    expect(completeResponse.ok()).toBeTruthy();

    await expect(page.getByTestId(toggleTestId)).toHaveAttribute(
      'aria-label',
      `Mark todo as incomplete: ${todoTitle}`,
    );
  });

  test('supports keyboard creation through the Spending category modal', async ({
    page,
    baseURL,
  }) => {
    const uniqueId = randomUUID();
    const credentials = {
      email: `e2e-keyboard-spending-${uniqueId}@example.com`,
      username: `e2e_keyboard_spending_${uniqueId.replace(/-/g, '_').slice(0, 16)}`,
      password: 'Password123!',
    };
    const categoryName = `Keyboard category ${uniqueId.slice(0, 8)}`;

    await registerAndLogin(page, baseURL, credentials);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await tabUntilTestId(page, 'nav-spending');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Spending' })).toBeVisible();

    await tabUntilTestId(page, 'spending-open-manage-categories');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Manage Categories' })).toBeVisible();

    await tabUntilTestId(page, 'spending-category-name');
    await page.keyboard.insertText(categoryName);
    await tabUntilTestId(page, 'spending-category-create');

    const createCategoryPromise = page.waitForResponse(
      (response) =>
        response.url().includes('/v1/spending/categories') &&
        response.request().method() === 'POST',
    );
    await page.keyboard.press('Enter');
    const createCategoryResponse = await createCategoryPromise;
    expect(createCategoryResponse.status()).toBe(201);

    await expect(page.getByRole('heading', { name: 'Manage Categories' })).toHaveCount(0);

    await tabUntilTestId(page, 'spending-open-new-transaction');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'New Transaction' })).toBeVisible();

    await tabUntilTestId(page, 'spending-transaction-category');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option', { name: categoryName, exact: true })).toBeVisible();
  });
});
