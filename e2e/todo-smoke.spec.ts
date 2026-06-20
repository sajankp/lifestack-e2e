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

  test('should create a timed todo for today and complete it @smoke', async ({ page }) => {
    const taskTitle = `Smoke Todo ${Date.now()}`;
    const today = new Date();
    const todayValue = today.toISOString().slice(0, 10);

    await page.getByTestId('nav-todo').click();
    await expect(page.getByRole('heading', { name: 'Todos' })).toBeVisible();

    await page.getByRole('button', { name: 'Add Task' }).click();

    await page.getByTestId('todo-new-title').fill(taskTitle);
    await page.getByTestId('todo-new-due-date').click();
    await page.locator(`[data-day="${todayValue}"]`).click();
    await page.getByTestId('todo-new-due-time').fill('16:00');
    const todoPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/todo/') && res.request().method() === 'POST'
    );
    await page.getByTestId('todo-new-submit').click();
    const todoResponse = await todoPromise;
    expect(todoResponse.ok()).toBeTruthy();
    const todo = (await todoResponse.json()) as { due_date: string };
    const dueAt = new Date(todo.due_date);
    expect(dueAt.toISOString()).toBe(`${todayValue}T16:00:00.000Z`);

    await expect(page.getByRole('heading', { name: taskTitle })).toBeVisible();
    await expect(page.getByText(/^Due:/).filter({ hasText: /4:00/ })).toBeVisible();
    await page.getByRole('button', { name: `Mark todo as complete: ${taskTitle}` }).click();
    await expect(page.getByRole('button', { name: `Mark todo as incomplete: ${taskTitle}` })).toBeVisible();
  });
});
