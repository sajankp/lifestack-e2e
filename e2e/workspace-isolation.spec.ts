import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test';

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

async function csrfHeaders(source: BrowserContext | APIRequestContext) {
  const state = await source.storageState();
  const csrfCookie = state.cookies.find((cookie) => cookie.name === 'csrf_token');
  expect(csrfCookie, 'CSRF token cookie should be defined').toBeDefined();
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
  const accountId = await createAccount(request, workspaceId, `${description} account`, 'wallet');
  const categoryId = await createCategory(request, workspaceId, `${description} category`);

  const response = await request.post(`${API_BASE}/spending/transactions`, {
    headers: await csrfHeaders(request),
    data: {
      account_id: accountId,
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

async function createAccount(
  request: APIRequestContext,
  workspaceId: string,
  name: string,
  accountType = 'brokerage',
): Promise<string> {
  await selectWorkspace(request, workspaceId);
  const response = await request.post(`${API_BASE}/finance/accounts`, {
    headers: await csrfHeaders(request),
    data: { name, account_type: accountType, default_currency_code: 'USD' },
  });
  expect(response.status()).toBe(201);
  const account = (await response.json()) as { public_id: string };
  return account.public_id;
}

async function transferCash(
  request: APIRequestContext,
  workspaceId: string,
  fromAccountId: string,
  toAccountId: string,
  amount: string,
  currency: string,
): Promise<void> {
  await selectWorkspace(request, workspaceId);
  const response = await request.post(`${API_BASE}/finance/transfers`, {
    headers: await csrfHeaders(request),
    data: {
      from_account_id: fromAccountId,
      to_account_id: toAccountId,
      from_module: 'spending',
      to_module: 'investing',
      gross_amount: amount,
      net_amount_received: amount,
      from_currency_code: currency,
      to_currency_code: currency,
      occurred_at: new Date().toISOString(),
    },
  });
  expect(response.status(), `Transfer failed: ${await response.text()}`).toBe(201);
}

async function createHolding(
  request: APIRequestContext,
  workspaceId: string,
  symbol: string,
  accountId: string,
): Promise<string> {
  await selectWorkspace(request, workspaceId);

  // Holdings are order-derived only (manual POST /investing/holdings was
  // deliberately removed, commit 51a20c2) — fund the brokerage account then
  // place a buy order to create the holding, matching every other spec.
  const walletAccountId = await createAccount(request, workspaceId, `${symbol} funding wallet`, 'wallet');
  await transferCash(request, workspaceId, walletAccountId, accountId, '2000', 'USD');

  const orderResponse = await request.post(`${API_BASE}/investing/orders`, {
    headers: await csrfHeaders(request),
    data: {
      account_id: accountId,
      order_type: 'buy',
      symbol,
      quantity: '10',
      price_per_unit: '100.00',
      currency: 'USD',
      occurred_at: new Date().toISOString(),
    },
  });
  expect(orderResponse.status(), `Order placement failed: ${await orderResponse.text()}`).toBe(201);

  const holdingsResponse = await request.get(`${API_BASE}/investing/holdings`, {
    headers: await csrfHeaders(request),
  });
  expect(holdingsResponse.status()).toBe(200);
  const holdings = (await holdingsResponse.json()) as { items: { public_id: string; symbol: string }[] };
  const holding = holdings.items.find((item) => item.symbol === symbol);
  expect(holding, `No holding found for symbol ${symbol}`).toBeDefined();
  return holding!.public_id;
}

async function createImportBatch(
  request: APIRequestContext,
  workspaceId: string,
  moduleName: string,
  csvContent: string,
): Promise<string> {
  await selectWorkspace(request, workspaceId);
  const response = await request.post(`${API_BASE}/imports`, {
    headers: await csrfHeaders(request),
    multipart: {
      module: moduleName,
      file: {
        name: 'import.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csvContent, 'utf8'),
      },
    },
  });
  expect(response.status()).toBe(202);
  const body = (await response.json()) as { import_batch: { public_id: string } };
  return body.import_batch.public_id;
}

async function createExport(
  request: APIRequestContext,
  workspaceId: string,
): Promise<string> {
  await selectWorkspace(request, workspaceId);
  const response = await request.post(`${API_BASE}/exports`, {
    headers: await csrfHeaders(request),
    data: { format: 'json', modules: ['todo'] },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { public_id: string };
  return body.public_id;
}

test.describe('Workspace isolation E2E Flow', () => {
  test('switches visible workspace data and blocks cross-workspace todo and spending lookup', async ({
    page,
    request,
  }) => {
    const ownerCredentials = makeCredentials('owner');
    const memberCredentials = makeCredentials('member');

    // 1. Register and login member
    const member = await registerViaApi(request, memberCredentials);
    const personalWorkspace = member.workspace;

    const suffix = memberCredentials.username.slice(-8);
    const personalTodoTitle = `Personal workspace task ${suffix}`;
    const sharedTodoTitle = `Shared workspace task ${suffix}`;

    // Member creates their personal resources
    const personalTodoId = await createTodo(
      request,
      personalWorkspace.public_id,
      personalTodoTitle,
    );
    const personalTransactionDescription = `Personal workspace lunch ${suffix}`;
    const personalTransactionId = await createSpendingTransaction(
      request,
      personalWorkspace.public_id,
      personalTransactionDescription,
      '12.34',
    );
    const personalAccountName = `Personal Acct ${suffix}`;
    const personalAccountId = await createAccount(request, personalWorkspace.public_id, personalAccountName);
    const personalHoldingId = await createHolding(
      request,
      personalWorkspace.public_id,
      'AAPL',
      personalAccountId,
    );
    const personalCsv = 'occurred_at,type,amount,category,description\n2026-06-01,expense,10.00,Other,lunch\n';
    const personalImportId = await createImportBatch(
      request,
      personalWorkspace.public_id,
      'spending-transactions',
      personalCsv,
    );
    const personalExportId = await createExport(request, personalWorkspace.public_id);

    // 2. Register and login owner
    const owner = await registerViaApi(request, ownerCredentials);
    const sharedWorkspace = owner.workspace;

    // Owner creates their shared resources
    const sharedTodoId = await createTodo(
      request,
      sharedWorkspace.public_id,
      sharedTodoTitle,
    );
    const sharedTransactionDescription = `Shared workspace software ${suffix}`;
    const sharedTransactionId = await createSpendingTransaction(
      request,
      sharedWorkspace.public_id,
      sharedTransactionDescription,
      '56.78',
    );
    const sharedAccountName = `Shared Acct ${suffix}`;
    const sharedAccountId = await createAccount(request, sharedWorkspace.public_id, sharedAccountName);
    const sharedHoldingId = await createHolding(
      request,
      sharedWorkspace.public_id,
      'MSFT',
      sharedAccountId,
    );
    const sharedCsv = 'occurred_at,type,amount,category,description\n2026-06-01,expense,50.00,Other,dinner\n';
    const sharedImportId = await createImportBatch(
      request,
      sharedWorkspace.public_id,
      'spending-transactions',
      sharedCsv,
    );
    const sharedExportId = await createExport(request, sharedWorkspace.public_id);

    // Owner invites member
    await loginViaApi(request, ownerCredentials);
    const inviteResponse = await request.post(
      `${API_BASE}/platform/workspaces/${sharedWorkspace.public_id}/members`,
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

    // 3. Login member for UI and API isolation tests
    await loginViaApi(page.request, memberCredentials);
    await loginViaApi(request, memberCredentials);

    const workspaceResponse = await page.request.get(`${API_BASE}/platform/workspaces/`);
    expect(workspaceResponse.status()).toBe(200);
    const workspacePayload = (await workspaceResponse.json()) as { items: WorkspaceInfo[] };
    const memberPersonalWorkspace = workspacePayload.items.find(
      (w) => w.public_id === personalWorkspace.public_id,
    );
    const memberSharedWorkspace = workspacePayload.items.find(
      (w) => w.public_id === sharedWorkspace.public_id,
    );
    expect(memberPersonalWorkspace, 'Member personal workspace should be available').toBeTruthy();
    expect(memberSharedWorkspace, 'Invited owner workspace should be available').toBeTruthy();

    await selectWorkspace(page.request, personalWorkspace.public_id);
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
    await expect(page.getByTestId('transaction-description-table').filter({ hasText: personalTransactionDescription })).toBeVisible();
    await expect(page.getByTestId('transaction-description-table').filter({ hasText: sharedTransactionDescription })).toHaveCount(0);

    await page.goto('/investing');
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();
    await expect(page.getByTestId('investing-holding-symbol-AAPL')).toBeVisible();
    await expect(page.getByTestId('investing-holding-symbol-MSFT')).toHaveCount(0);

    const sharedSelectResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/platform/workspaces/${sharedWorkspace!.public_id}/select`) &&
        response.request().method() === 'POST',
    );
    await page.getByTestId('header-workspace-select').selectOption(sharedWorkspace!.public_id);
    const sharedSelectResponse = await sharedSelectResponsePromise;
    expect(sharedSelectResponse.ok()).toBeTruthy();
    await expect(page.getByTestId('header-workspace-select')).toHaveValue(
      sharedWorkspace!.public_id,
    );
    await page.goto('/todo');
    await expect(page.getByText(sharedTodoTitle)).toBeVisible();
    await expect(page.getByText(personalTodoTitle)).toHaveCount(0);

    await page.goto('/spending');
    await expect(page.getByTestId('transaction-description-table').filter({ hasText: sharedTransactionDescription })).toBeVisible();
    await expect(page.getByTestId('transaction-description-table').filter({ hasText: personalTransactionDescription })).toHaveCount(0);

    await page.goto('/investing');
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();
    await expect(page.getByTestId('investing-holding-symbol-MSFT')).toBeVisible();
    await expect(page.getByTestId('investing-holding-symbol-AAPL')).toHaveCount(0);

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

    // While sharedWorkspace is selected, check that personalWorkspace resources are inaccessible
    // 1. Investing holding
    const patchPersonalHoldingFromShared = await page.request.patch(
      `${API_BASE}/investing/holdings/${personalHoldingId}`,
      {
        headers: await csrfHeaders(page.request),
        data: {},
      }
    );
    expect(patchPersonalHoldingFromShared.status()).toBe(404);

    const deletePersonalHoldingFromShared = await page.request.delete(
      `${API_BASE}/investing/holdings/${personalHoldingId}`,
      {
        headers: await csrfHeaders(page.request),
      }
    );
    expect(deletePersonalHoldingFromShared.status()).toBe(404);

    // 2. Imports batch
    const getPersonalImportFromShared = await page.request.get(
      `${API_BASE}/imports/${personalImportId}`,
    );
    expect(getPersonalImportFromShared.status()).toBe(404);

    // 3. Exports record
    const getPersonalExportFromShared = await page.request.get(
      `${API_BASE}/exports/${personalExportId}`,
    );
    expect(getPersonalExportFromShared.status()).toBe(404);

    // Select personal workspace to check shared workspace resources are inaccessible
    await selectWorkspace(page.request, personalWorkspace.public_id);

    // 1. Investing holding
    const patchSharedHoldingFromPersonal = await page.request.patch(
      `${API_BASE}/investing/holdings/${sharedHoldingId}`,
      {
        headers: await csrfHeaders(page.request),
        data: {},
      }
    );
    expect(patchSharedHoldingFromPersonal.status()).toBe(404);

    const deleteSharedHoldingFromPersonal = await page.request.delete(
      `${API_BASE}/investing/holdings/${sharedHoldingId}`,
      {
        headers: await csrfHeaders(page.request),
      }
    );
    expect(deleteSharedHoldingFromPersonal.status()).toBe(404);

    // 2. Imports batch
    const getSharedImportFromPersonal = await page.request.get(
      `${API_BASE}/imports/${sharedImportId}`,
    );
    expect(getSharedImportFromPersonal.status()).toBe(404);

    // 3. Exports record
    const getSharedExportFromPersonal = await page.request.get(
      `${API_BASE}/exports/${sharedExportId}`,
    );
    expect(getSharedExportFromPersonal.status()).toBe(404);
  });
});

