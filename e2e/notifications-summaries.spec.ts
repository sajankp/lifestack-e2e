import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import { retryUnauthorized } from './helpers/api';
import { triggerWeeklySummary } from './helpers/e2e-hooks';

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
    email: `e2e-notifications-${label}-${uniqueId}@example.com`,
    username: `notify_${label}_${uniqueId}`,
    password: PASSWORD,
  };
};

function currentUtcWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return monday.toISOString().slice(0, 10);
}

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

  let response: import('@playwright/test').APIResponse | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await request.post(`${API_BASE}/auth/login`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: params.toString(),
    });
    if (response.status() === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(response, `Login request was not attempted for ${credentials.email}`).toBeDefined();
  expect(response!.status(), `Login failed for ${credentials.email}: ${await response!.text()}`).toBe(200);
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

  const meResponse = await retryUnauthorized(() => request.get(`${API_BASE}/auth/me`));
  expect(meResponse.status()).toBe(200);
  const me = (await meResponse.json()) as { public_id: string };

  const workspaceResponse = await retryUnauthorized(
    () => request.get(`${API_BASE}/platform/workspaces/`),
  );
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
): Promise<void> {
  await selectWorkspace(request, workspaceId);

  const response = await request.post(`${API_BASE}/todo/`, {
    headers: await csrfHeaders(request),
    data: { title, priority: 'medium', status: 'pending' },
  });
  expect([200, 201], `Todo creation failed: ${await response.text()}`).toContain(
    response.status(),
  );
}

async function unreadCount(request: APIRequestContext): Promise<number> {
  const response = await request.get(`${API_BASE}/notifications/unread-count`);
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as { count: number };
  return payload.count;
}

test.describe('Notifications and Weekly Summaries E2E Flow', () => {
  test('renders generated weekly summary notification and marks it read', async ({
    page,
    baseURL,
  }) => {
    const uniqueId = randomUUID();

    await registerAndLogin(page, baseURL, {
      email: `e2e-notifications-${uniqueId}@example.com`,
      username: `e2e_notifications_${uniqueId.replace(/-/g, '_').slice(0, 24)}`,
      password: 'Password123!',
    });

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    const summaryRun = await triggerWeeklySummary(page);
    expect(summaryRun.status).toBe('ok');
    expect(summaryRun.summary_public_id).toBeTruthy();
    await expect.poll(() => unreadCount(page.request)).toBe(1);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByTestId('header-notifications')).toContainText('1');

    await page.getByTestId('header-notifications').click();
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    await expect(page.getByText(/Weekly summary ready:/)).toBeVisible();
    await expect(page.getByText('System · info')).toBeVisible();

    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect.poll(() => unreadCount(page.request)).toBe(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    await expect(page.getByTestId('header-notifications')).not.toContainText('1');

    await page.getByTestId('nav-summaries').click();
    await expect(page.getByRole('heading', { name: 'Weekly Summaries' })).toBeVisible();
    const summaryArticle = page.getByRole('article').filter({ hasText: /^Week of / }).first();
    await expect(summaryArticle).toBeVisible();
    await expect(summaryArticle.getByText('Todo', { exact: true })).toBeVisible();
    await expect(summaryArticle.getByText('Spending', { exact: true })).toBeVisible();
    await expect(summaryArticle.getByText('Investing', { exact: true })).toBeVisible();
    await expect(summaryArticle.getByText('Tasks created')).toBeVisible();
    // The message renders twice within one card (net-worth + returns sections) —
    // an instance of the warning-duplication issue flagged in the 2026-07-16 UX
    // review (Real-Data pass); .first() until the web dedupes repeated warnings.
    await expect(
      summaryArticle
        .getByText(
          'Weekly comparison unavailable because compatible start and end snapshots were not found.',
        )
        .first(),
    ).toBeVisible();

    // The standalone "Latest weekly summary" dashboard card was removed in the
    // UX-REVIEW dashboard restructure (Task 6) — weekly-summary freshness now
    // surfaces only as a composed Morning Briefing line, not a fixed string.
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('keeps notifications and weekly summaries isolated when switching workspaces', async ({
    page,
    request,
  }) => {
    const ownerCredentials = makeCredentials('owner');
    const memberCredentials = makeCredentials('member');
    const weekStart = currentUtcWeekStart();
    const suffix = randomUUID().slice(0, 8);

    const member = await registerViaApi(request, memberCredentials);
    const owner = await registerViaApi(request, ownerCredentials);

    await loginViaApi(request, ownerCredentials);
    const inviteResponse = await request.post(
      `${API_BASE}/platform/workspaces/${owner.workspace.public_id}/members`,
      {
        headers: await csrfHeaders(request),
        data: {
          user_public_id: member.userId,
          role: 'owner',
        },
      },
    );
    expect([200, 201], `Workspace owner invite failed: ${await inviteResponse.text()}`).toContain(
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

    await createTodo(page.request, personalWorkspace!.public_id, `Personal summary task ${suffix}`);
    await createTodo(page.request, sharedWorkspace!.public_id, `Shared summary task A ${suffix}`);
    await createTodo(page.request, sharedWorkspace!.public_id, `Shared summary task B ${suffix}`);

    await selectWorkspace(page.request, personalWorkspace!.public_id);
    await page.goto('/summaries');
    await expect(page.getByRole('heading', { name: 'Weekly Summaries' })).toBeVisible();
    const personalSummaryRun = await triggerWeeklySummary(page, weekStart);
    expect(personalSummaryRun.status).toBe('ok');
    expect(personalSummaryRun.week_start).toBe(weekStart);
    await expect.poll(() => unreadCount(page.request)).toBe(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Weekly Summaries' })).toBeVisible();
    await expect(page.getByText('Tasks created').locator('..')).toContainText('1');

    await selectWorkspace(page.request, sharedWorkspace!.public_id);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Weekly Summaries' })).toBeVisible();
    await expect(page.getByText('No weekly summaries yet')).toBeVisible();
    await expect.poll(() => unreadCount(page.request)).toBe(0);

    const sharedSummaryRun = await triggerWeeklySummary(page, weekStart);
    expect(sharedSummaryRun.status).toBe('ok');
    expect(sharedSummaryRun.week_start).toBe(weekStart);
    expect(sharedSummaryRun.summary_public_id).not.toBe(personalSummaryRun.summary_public_id);
    await expect.poll(() => unreadCount(page.request)).toBe(1);
    await page.reload();
    await expect(page.getByText('Tasks created').locator('..')).toContainText('2');

    await page.getByTestId('header-notifications').click();
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    await expect(page.getByText(/Weekly summary ready:/)).toBeVisible();
    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect.poll(() => unreadCount(page.request)).toBe(0);

    await selectWorkspace(page.request, personalWorkspace!.public_id);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    await expect.poll(() => unreadCount(page.request)).toBe(1);
    await page.getByTestId('nav-summaries').click();
    await expect(page.getByText('Tasks created').locator('..')).toContainText('1');
  });
});
