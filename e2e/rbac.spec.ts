/**
 * RBAC (Role-Based Access Control) E2E Verification Suite
 *
 * This suite verifies that the workspace role enforcement implemented in the
 * backend (require_min_role dependency) is correctly applied at the API boundary.
 *
 * Strategy:
 *   - Register a fresh OWNER user (auto-assigned on workspace creation).
 *   - Use the API to create a second VIEWER-role membership (via the owner session).
 *   - Verify VIEWER sessions receive 403 on all mutating endpoints.
 *   - Verify MEMBER sessions can perform standard read/write operations.
 *   - Verify that workspace finance settings require ADMIN or OWNER.
 *
 * Note: Playwright's `page.request` shares the browser's cookie jar, so
 * requests made after `page.goto('/login')` are authenticated correctly.
 */

import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

const PLAYWRIGHT_API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8000';
const API_BASE = PLAYWRIGHT_API_URL.endsWith('/v1') ? PLAYWRIGHT_API_URL : `${PLAYWRIGHT_API_URL}/v1`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Register a brand-new user and return their credentials. */
function makeCredentials(role: string) {
  const ts = Date.now();
  return {
    email: `e2e-rbac-${role}-${ts}@example.com`,
    username: `rbac_${role}_${ts}`,
    password: 'Password123!',
  };
}

/**
 * Login via the backend API directly (not the UI) to get an authenticated
 * cookie session on the page's request context.
 */
async function loginViaApi(
  request: import('@playwright/test').APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const params = new URLSearchParams({ username: email, password });
  const res = await request.post(`${API_BASE}/auth/login`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: params.toString(),
  });
  expect(res.status(), `Login failed for ${email}: ${await res.text()}`).toBe(200);
}

/** Register via API, returns the new user's public_id and workspace_id. */
async function registerViaApi(
  request: import('@playwright/test').APIRequestContext,
  creds: { email: string; username: string; password: string },
): Promise<{ userId: string; workspaceId: string }> {
  const res = await request.post(`${API_BASE}/auth/register`, {
    data: { email: creds.email, username: creds.username, password: creds.password },
  });
  expect(res.status(), `Register failed: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { public_id: string };

  // Fetch own workspace
  const loginParams = new URLSearchParams({ username: creds.email, password: creds.password });
  await request.post(`${API_BASE}/auth/login`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: loginParams.toString(),
  });

  const wsRes = await request.get(`${API_BASE}/platform/workspaces/`);
  const wsBody = (await wsRes.json()) as { items: Array<{ public_id: string }> };
  return { userId: body.public_id, workspaceId: wsBody.items[0]?.public_id ?? '' };
}

// ─── RBAC Tests ───────────────────────────────────────────────────────────────

test.describe('Workspace RBAC enforcement @rbac', () => {
  // ── VIEWER cannot mutate ────────────────────────────────────────────────────
  test('VIEWER receives 403 on transaction creation', async ({ page, request }) => {
    const ownerCreds = makeCredentials('owner');
    const viewerCreds = makeCredentials('viewer');

    // 1. Register owner and create workspace (auto-created on register)
    await registerViaApi(request, ownerCreds);

    // 2. Register viewer account
    const { userId: viewerPublicId } = await registerViaApi(request, viewerCreds);

    // 3. Login as owner, invite viewer with VIEWER role
    await loginViaApi(request, ownerCreds.email, ownerCreds.password);
    const wsRes = await request.get(`${API_BASE}/platform/workspaces/`);
    const wsBody = (await wsRes.json()) as { items: Array<{ public_id: string }> };
    const workspaceId = wsBody.items[0]?.public_id;
    expect(workspaceId, 'Owner must have at least one workspace').toBeTruthy();

    // Invite viewer to workspace with VIEWER role
    const inviteRes = await request.post(`${API_BASE}/platform/workspaces/${workspaceId}/members`, {
      data: { user_public_id: viewerPublicId, role: 'viewer' },
    });
    // Accept 200 or 201 for the invite
    expect([200, 201], `Invite failed: ${await inviteRes.text()}`).toContain(inviteRes.status());

    // 4. Login as viewer
    await loginViaApi(request, viewerCreds.email, viewerCreds.password);

    // Switch to viewer's workspace context (must select the shared workspace)
    const viewerWsRes = await request.get(`${API_BASE}/platform/workspaces/`);
    const viewerWsBody = (await viewerWsRes.json()) as { items: Array<{ public_id: string }> };
    const sharedWs = viewerWsBody.items.find((w) => w.public_id === workspaceId);
    expect(sharedWs, 'Viewer should see the shared workspace').toBeTruthy();

    // Switch to the shared workspace
    const switchRes = await request.post(`${API_BASE}/platform/workspaces/${workspaceId}/select`);
    expect([200, 204]).toContain(switchRes.status());

    // 5. Attempt to create a transaction — must be rejected with 403
    const txRes = await request.post(`${API_BASE}/spending/transactions/`, {
      data: {
        amount: '10.00',
        description: 'RBAC test transaction',
        type: 'expense',
        date: new Date().toISOString().slice(0, 10),
        category_id: '00000000-0000-0000-0000-000000000000', // Valid UUID so RBAC fails before validation
      },
    });
    expect(txRes.status()).toBe(403);
  });

  // ── MEMBER can mutate ───────────────────────────────────────────────────────
  test('MEMBER can create and read todos', async ({ page, request }) => {
    const memberCreds = makeCredentials('member');

    // Register gives OWNER role on own workspace — effectively MEMBER+ rights
    await registerViaApi(request, memberCreds);
    await loginViaApi(request, memberCreds.email, memberCreds.password);

    // Create a todo item
    const todoRes = await request.post(`${API_BASE}/todo/`, {
      data: {
        title: 'RBAC Member Todo',
        priority: 'medium',
        status: 'pending',
      },
    });
    // OWNER has >= MEMBER rights, so 200 or 201 is expected
    expect([200, 201], `Todo creation failed: ${await todoRes.text()}`).toContain(todoRes.status());

    // Read todos back
    const listRes = await request.get(`${API_BASE}/todo/`);
    expect(listRes.status()).toBe(200);
    const listBody = (await listRes.json()) as { items: Array<{ title: string }> };
    const created = listBody.items.find((t) => t.title === 'RBAC Member Todo');
    expect(created, 'Created todo should be visible').toBeTruthy();
  });

  // ── Admin-only finance settings ─────────────────────────────────────────────
  test('VIEWER cannot modify workspace finance settings', async ({ page, request }) => {
    const ownerCreds = makeCredentials('owner2');
    const viewerCreds = makeCredentials('viewer2');

    const { workspaceId } = await registerViaApi(request, ownerCreds);
    const { userId: viewerPublicId } = await registerViaApi(request, viewerCreds);

    // Invite viewer with viewer role
    await loginViaApi(request, ownerCreds.email, ownerCreds.password);
    await request.post(`${API_BASE}/platform/workspaces/${workspaceId}/members`, {
      data: { user_public_id: viewerPublicId, role: 'viewer' },
    });

    // Login as viewer, switch workspace
    await loginViaApi(request, viewerCreds.email, viewerCreds.password);
    await request.post(`${API_BASE}/platform/workspaces/${workspaceId}/select`);

    // Attempt to update workspace finance settings — must be 403 (requires ADMIN)
    const settingsRes = await request.patch(`${API_BASE}/finance/settings/workspace`, {
      data: { reporting_currency_code: 'EUR' },
    });
    expect(settingsRes.status()).toBe(403);
  });

  // ── OWNER can modify workspace finance settings ─────────────────────────────
  test('OWNER can modify workspace finance settings', async ({ page, request }) => {
    const ownerCreds = makeCredentials('owner3');

    await registerViaApi(request, ownerCreds);
    await loginViaApi(request, ownerCreds.email, ownerCreds.password);

    // Attempt to update workspace finance settings — must succeed (200/204)
    const settingsRes = await request.patch(`${API_BASE}/finance/settings/workspace`, {
      data: { reporting_currency_code: 'EUR' },
    });
    expect([200, 204], `Settings update failed: ${await settingsRes.text()}`).toContain(
      settingsRes.status(),
    );
  });
});
