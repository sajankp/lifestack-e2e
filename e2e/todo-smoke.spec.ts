import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { registerAndLogin } from './helpers/auth';

test.describe('Todo Smoke Flow', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-todo-${uniqueId}@example.com`;
    testUsername = `e2e_todo_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('should create and complete a todo task @smoke', async ({ page }) => {
    const taskTitle = `Smoke Todo ${Date.now()}`;

    await page.getByTestId('nav-todo').click();
    await expect(page.getByRole('heading', { name: 'Todos' })).toBeVisible();

    await page.getByTestId('todo-new-title').fill(taskTitle);
    await page.getByTestId('todo-new-submit').click();

    await expect(page.getByRole('heading', { name: taskTitle })).toBeVisible();
    await page.getByRole('button', { name: `Mark todo as complete: ${taskTitle}` }).click();
    await expect(page.getByRole('button', { name: `Mark todo as incomplete: ${taskTitle}` })).toBeVisible();
  });
});
