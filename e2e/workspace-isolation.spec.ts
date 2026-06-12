import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';

const PLAYWRIGHT_API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8000';
const API_BASE = PLAYWRIGHT_API_URL.endsWith('/v1') ? PLAYWRIGHT_API_URL : `${PLAYWRIGHT_API_URL}/v1`;
const PASSWORD = 'Password123!';

type Credentials = {
  email: string;
  username: string;
  password: string;
};

type WorkspaceInfo = {
  public_id: string;
  name: string;
  role: string;
};

const makeCredentials = (label: string): Credentials => {
  const uniqueId = randomUUID().slice(0, 8);
  return {
    email: `e2e-workspace-${label}-${uniqueId}@example.com`,
    username: `ws_${label}_${uniqueId}`,
    password: PASSWORD,
  };
};

async function csrfHeaders(request: APIRequestContext) {
  const state = await request.storageState();
  const csrfCookie = state.cookies.find((cookie) => cookie.name === 'csrf_token');
  const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';

  return {
    Origin: origin,
    Referer: `${origin}/`,
    ...(csrfCookie ? { 'X-CSRF-Token': csrfCookie.value } : {}),
  };
}

async function loginViaApi(request: APIRequestContext, credentials: Credentials): Promise<void> {
  const params = new URLSearchParams({
    username: credentials.email,
    password: credentials.password,
  });

  const response = await request.post(`${API_BASE}/auth/login`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: params.toString(),
  });

  expect(response.status(), `Login failed for ${credentials.email}: ${await response.text()}`).toBe(200);
}

async function registerViaApi(
  request: APIRequestContext,
  credentials: Credentials,
): Promise<{ userId: string; workspace: WorkspaceInfo }> {
  const registerResponse = await request.post(`${API_BASE}/auth/register`, {
    data: {
      email: credentials.email,
      username: credentials.username,
      password: credentials.password,
    },
  });
  expect(
    [200, 201],
    `Register failed for ${credentials.email}: ${await registerResponse.text()}`,
  ).toContain(registerResponse.status());

  await loginViaApi(request, credentials);

  const meResponse = await request.get(`${API_BASE}/auth/me`);
  expect(meResponse.status()).toBe(200);
  const me = (await meResponse.json()) as { public_id: string };

  const workspaceResponse = await request.get(`${API_BASE}/platform/workspaces/`);
  expect(workspaceResponse.status()).toBe(200);
  const workspaces = (await workspaceResponse.json()) as { items: WorkspaceInfo[] };
  expect(workspaces.items.length).toBeGreaterThan(0);

  return { userId: me.public_id, workspace: workspaces.items[0] };
}

async function selectWorkspace(request: APIRequestContext, workspaceId: string): Promise<void> {
  const response = await request.post(`${API_BASE}/platform/workspaces/${workspaceId}/select`, {
    headers: await csrfHeaders(request),
  });
  expect([200, 204], `Workspace select failed: ${await response.text()}`).toContain(
    response.status(),
  );
}

async function createTodo(
  request: APIRequestContext,
  workspaceId: string,
  title: string,
): Promise<string> {
  await selectWorkspace(request, workspaceId);

  const response = await request.post(`${API_BASE}/todo/`, {
    headers: await csrfHeaders(request),
    data: { title, priority: 'medium', status: 'pending' },
  });
  expect([200, 201], `Todo creation failed: ${await response.text()}`).toContain(
    response.status(),
  );

  const todo = (await response.json()) as { public_id: string };
  return todo.public_id;
}

async function createCategory(
  request: APIRequestContext,
  workspaceId: string,
  name: string,
): Promise<string> {
  await selectWorkspace(request, workspaceId);

  const response = await request.post(`${API_BASE}/spending/categories`, {
    headers: await csrfHeaders(request),
    data: { name, color: '#38bdf8', icon: 'tag' },
  });
  expect([200, 201], `Category creation failed: ${await response.text()}`).toContain(
    response.status(),
  );

  const category = (await response.json()) as { public_id: string };
  return category.public_id;
}

async function createSpendingTransaction(
  request: APIRequestContext,
  workspaceId: string,
  description: string,
  amount: string,
): Promise<string> {
  const categoryId = await createCategory(request, workspaceId, `${description} category`);

  const response = await request.post(`${API_BASE}/spending/transactions`, {
    headers: await csrfHeaders(request),
    data: {
      category_id: categoryId,
      amount,
      type: 'expense',
      occurred_at: new Date().toISOString(),
      description,
      wallet_name: `${description} wallet`,
      labels: 'workspace-isolation',
    },
  });
  expect([200, 201], `Transaction creation failed: ${await response.text()}`).toContain(
    response.status(),
  );

  const transaction = (await response.json()) as { public_id: string };
  return transaction.public_id;
}

test.describe('Workspace isolation E2E Flow', () => {
  test('switches visible workspace data and blocks cross-workspace todo and spending lookup', async ({
    page,
    request,
  }) => {
    const ownerCredentials = makeCredentials('owner');
    const memberCredentials = makeCredentials('member');

    const member = await registerViaApi(request, memberCredentials);
    const owner = await registerViaApi(request, ownerCredentials);

    await loginViaApi(request, ownerCredentials);
    const inviteResponse = await request.post(
      `${API_BASE}/platform/workspaces/${owner.workspace.public_id}/members`,
      {
        headers: await csrfHeaders(request),
        data: {
          user_public_id: member.userId,
          role: 'member',
        },
      },
    );
    expect([200, 201], `Workspace invite failed: ${await inviteResponse.text()}`).toContain(
      inviteResponse.status(),
    );

    await loginViaApi(page.request, memberCredentials);

    const workspaceResponse = await page.request.get(`${API_BASE}/platform/workspaces/`);
    expect(workspaceResponse.status()).toBe(200);
    const workspacePayload = (await workspaceResponse.json()) as { items: WorkspaceInfo[] };
    const personalWorkspace = workspacePayload.items.find(
      (workspace) => workspace.public_id === member.workspace.public_id,
    );
    const sharedWorkspace = workspacePayload.items.find(
      (workspace) => workspace.public_id === owner.workspace.public_id,
    );
    expect(personalWorkspace, 'Member personal workspace should be available').toBeTruthy();
    expect(sharedWorkspace, 'Invited owner workspace should be available').toBeTruthy();

    const suffix = memberCredentials.username.slice(-8);
    const personalTodoTitle = `Personal workspace task ${suffix}`;
    const sharedTodoTitle = `Shared workspace task ${suffix}`;

    const personalTodoId = await createTodo(
      page.request,
      personalWorkspace!.public_id,
      personalTodoTitle,
    );
    const sharedTodoId = await createTodo(
      page.request,
      sharedWorkspace!.public_id,
      sharedTodoTitle,
    );
    const personalTransactionDescription = `Personal workspace lunch ${suffix}`;
    const sharedTransactionDescription = `Shared workspace software ${suffix}`;
    const personalTransactionId = await createSpendingTransaction(
      page.request,
      personalWorkspace!.public_id,
      personalTransactionDescription,
      '12.34',
    );
    const sharedTransactionId = await createSpendingTransaction(
      page.request,
      sharedWorkspace!.public_id,
      sharedTransactionDescription,
      '56.78',
    );

    await selectWorkspace(page.request, personalWorkspace!.public_id);
    await page.goto('/todo');
    await expect(page.getByRole('heading', { name: 'Todos' })).toBeVisible();
    await expect(page.getByTestId('header-workspace-select')).toHaveValue(
      personalWorkspace!.public_id,
    );
    await expect(page.getByText(personalTodoTitle)).toBeVisible();
    await expect(page.getByText(sharedTodoTitle)).toHaveCount(0);

    await page.goto('/spending');
    await expect(page.getByRole('heading', { name: 'Spending' })).toBeVisible();
    await expect(page.getByTestId('header-workspace-select')).toHaveValue(
      personalWorkspace!.public_id,
    );
    await expect(page.getByText(personalTransactionDescription, { exact: true })).toBeVisible();
    await expect(page.getByText(sharedTransactionDescription, { exact: true })).toHaveCount(0);

    const sharedSelectResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/platform/workspaces/${sharedWorkspace!.public_id}/select`) &&
        response.request().method() === 'POST',
    );
    await page.getByTestId('header-workspace-select').selectOption(sharedWorkspace!.public_id);
    await sharedSelectResponse;
    await expect(page.getByTestId('header-workspace-select')).toHaveValue(
      sharedWorkspace!.public_id,
    );
    await page.goto('/todo');
    await expect(page.getByText(sharedTodoTitle)).toBeVisible();
    await expect(page.getByText(personalTodoTitle)).toHaveCount(0);

    await page.goto('/spending');
    await expect(page.getByText(sharedTransactionDescription, { exact: true })).toBeVisible();
    await expect(page.getByText(personalTransactionDescription, { exact: true })).toHaveCount(0);

    const personalTodoFromSharedWorkspace = await page.request.get(
      `${API_BASE}/todo/${personalTodoId}`,
    );
    expect(personalTodoFromSharedWorkspace.status()).toBe(404);

    await selectWorkspace(page.request, personalWorkspace!.public_id);
    const sharedTodoFromPersonalWorkspace = await page.request.get(
      `${API_BASE}/todo/${sharedTodoId}`,
    );
    expect(sharedTodoFromPersonalWorkspace.status()).toBe(404);

    const sharedTransactionFromPersonalWorkspace = await page.request.get(
      `${API_BASE}/spending/transactions/${sharedTransactionId}`,
    );
    expect(sharedTransactionFromPersonalWorkspace.status()).toBe(404);

    await selectWorkspace(page.request, sharedWorkspace!.public_id);
    const personalTransactionFromSharedWorkspace = await page.request.get(
      `${API_BASE}/spending/transactions/${personalTransactionId}`,
    );
    expect(personalTransactionFromSharedWorkspace.status()).toBe(404);
  });
});
