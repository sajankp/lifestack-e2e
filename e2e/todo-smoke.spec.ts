import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { registerAndLogin } from './helpers/auth';
import { retryUnauthorized } from './helpers/api';

const PLAYWRIGHT_API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8000';
const API_BASE = PLAYWRIGHT_API_URL.endsWith('/v1') ? PLAYWRIGHT_API_URL : `${PLAYWRIGHT_API_URL}/v1`;

type ApiTodo = { public_id: string; title: string };

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

function waitForTodoWrite(page: Page, method: 'POST' | 'PATCH') {
  return page.waitForResponse(
    (res) => res.url().includes('/v1/todo/') && res.request().method() === method,
  );
}

async function createTodoViaApi(
  page: Page,
  data: Record<string, unknown>,
): Promise<ApiTodo> {
  const response = await retryUnauthorized(async () =>
    page.request.post(`${API_BASE}/todo/`, {
      headers: await csrfHeaders(page),
      data,
    }),
  );
  expect(response.status(), `Todo creation failed: ${await response.text()}`).toBe(201);
  return (await response.json()) as ApiTodo;
}

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
    await page.getByRole('button', { name: 'Today', exact: true }).click();
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
    await expect(page.getByText(/^Due:/).filter({ hasText: /16:00/ })).toBeVisible();
    await page.getByRole('button', { name: `Mark todo as complete: ${taskTitle}` }).click();

    // Completing a task moves it out of the open, date-grouped view and into
    // the collapsed Completed section (spec-068) — it no longer stays in
    // place with just its toggle button flipped.
    await expect(page.getByRole('heading', { name: taskTitle })).not.toBeVisible();
    await page.getByTestId('todo-completed-toggle').click();
    await expect(page.getByTestId(/^todo-completed-item-/).filter({ hasText: taskTitle })).toBeVisible();
  });

  test('subtasks indent under their parent, track progress, and cascade on parent completion (spec-068) @smoke', async ({ page }) => {
    const parentTitle = `Plan trip ${Date.now()}`;

    await page.getByTestId('nav-todo').click();
    await expect(page.getByRole('heading', { name: 'Todos' })).toBeVisible();

    await page.getByRole('button', { name: 'Add Task' }).click();
    await page.getByTestId('todo-new-title').fill(parentTitle);
    const createParent = waitForTodoWrite(page, 'POST');
    await page.getByTestId('todo-new-submit').click();
    await createParent;
    await expect(page.getByRole('heading', { name: parentTitle })).toBeVisible();

    const parentRow = page.getByTestId(/^todo-item-/).filter({ hasText: parentTitle });
    const addSubtaskButton = parentRow.getByRole('button', { name: 'Add subtask' });

    await addSubtaskButton.click();
    await expect(page.getByRole('heading', { name: `New subtask for "${parentTitle}"` })).toBeVisible();
    await page.getByTestId('todo-new-title').fill('Book flights');
    const createChildOne = waitForTodoWrite(page, 'POST');
    await page.getByTestId('todo-new-submit').click();
    await createChildOne;
    await expect(page.getByRole('heading', { name: 'Book flights' })).toBeVisible();

    await addSubtaskButton.click();
    await page.getByTestId('todo-new-title').fill('Pack bags');
    const createChildTwo = waitForTodoWrite(page, 'POST');
    await page.getByTestId('todo-new-submit').click();
    await createChildTwo;
    await expect(page.getByRole('heading', { name: 'Pack bags' })).toBeVisible();

    await expect(parentRow.getByText('0/2', { exact: true })).toBeVisible();

    const completeChildOne = waitForTodoWrite(page, 'PATCH');
    await page.getByRole('button', { name: 'Mark todo as complete: Book flights' }).click();
    await completeChildOne;
    await expect(parentRow.getByText('1/2', { exact: true })).toBeVisible();

    // Completing the parent cascades to its remaining open subtask and moves
    // the whole (now fully-completed) group out of the open view (spec-068).
    const completeParent = waitForTodoWrite(page, 'PATCH');
    await page.getByRole('button', { name: `Mark todo as complete: ${parentTitle}` }).click();
    await completeParent;
    await expect(page.getByRole('heading', { name: parentTitle })).not.toBeVisible();

    await page.getByTestId('todo-completed-toggle').click();
    // Match the parent's own row exactly — a loose substring filter also
    // matches its completed subtasks, which now carry a "↳ Plan trip …"
    // parent chip since parentTitleById resolves titles from both the open
    // and completed lists.
    const escapedParentTitle = parentTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(
      page.getByTestId(/^todo-completed-item-/).filter({ hasText: new RegExp(`^${escapedParentTitle}$`) }),
    ).toBeVisible();
    await expect(page.getByTestId(/^todo-completed-item-/).filter({ hasText: 'Pack bags' })).toBeVisible();
  });

  test('an overdue todo renders under the Overdue bucket header (spec-068) @smoke', async ({ page }) => {
    const overdueTitle = `Overdue task ${Date.now()}`;
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    await createTodoViaApi(page, {
      title: overdueTitle,
      priority: 'medium',
      due_date: yesterday,
    });

    await page.getByTestId('nav-todo').click();
    await expect(page.getByRole('heading', { name: 'Todos' })).toBeVisible();

    const overdueBucket = page.getByTestId('todo-bucket-overdue');
    await expect(overdueBucket).toBeVisible();
    await expect(overdueBucket.getByRole('heading', { name: overdueTitle })).toBeVisible();
  });

  test.describe('on a touch device', () => {
    test.use({ hasTouch: true });

    test('row actions are visible without hovering, and delete works (spec-068) @smoke', async ({ page }) => {
      const touchTitle = `Touch task ${Date.now()}`;
      await createTodoViaApi(page, { title: touchTitle, priority: 'medium' });

      await page.getByTestId('nav-todo').click();
      await expect(page.getByRole('heading', { name: 'Todos' })).toBeVisible();

      const row = page.getByTestId(/^todo-item-/).filter({ hasText: touchTitle });
      const deleteButton = row.getByRole('button', { name: 'Delete task' });
      const actionsContainer = deleteButton.locator('..');
      await expect(deleteButton).toBeVisible();
      // Row actions must not rely on hover on a touch device (spec-068) —
      // the wrapping container's opacity must be 1 without simulating hover.
      await expect(actionsContainer).toHaveCSS('opacity', '1');

      await deleteButton.click();
      await expect(page.getByRole('dialog').filter({ hasText: 'Delete task?' })).toBeVisible();
      await page.getByRole('button', { name: 'Delete' }).click();

      await expect(page.getByRole('heading', { name: touchTitle })).not.toBeVisible();
    });
  });
});
