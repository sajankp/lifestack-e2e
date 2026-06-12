/**
 * Voice Agent Widget / Capture Flow E2E Verification Suite
 */

import { test, expect } from '@playwright/test';

const PLAYWRIGHT_API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8000';
const API_BASE = PLAYWRIGHT_API_URL.endsWith('/v1') ? PLAYWRIGHT_API_URL : `${PLAYWRIGHT_API_URL}/v1`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCredentials(role: string) {
  const ts = Date.now();
  return {
    email: `e2e-capture-${role}-${ts}@example.com`,
    username: `capture_${role}_${ts}`,
    password: 'Password123!',
  };
}

async function getHeaders(context: import('@playwright/test').BrowserContext) {
  const state = await context.storageState();
  const csrfCookie = state.cookies.find((c) => c.name === 'csrf_token');
  expect(csrfCookie, 'CSRF token cookie should be defined').toBeDefined();
  const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';
  return {
    'Origin': origin,
    'Referer': `${origin}/`,
    ...(csrfCookie ? { 'X-CSRF-Token': csrfCookie.value } : {}),
  };
}

async function loginViaApi(
  request: import('@playwright/test').APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const params = new URLSearchParams({ username: email, password });
  let lastRes: import('@playwright/test').APIResponse | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    lastRes = await request.post(`${API_BASE}/auth/login`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: params.toString(),
    });
    if (lastRes.status() === 200) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  expect(lastRes, `Login request was not attempted for ${email}`).toBeDefined();
  expect(lastRes!.status(), `Login failed for ${email}: ${await lastRes!.text()}`).toBe(200);
}

async function registerViaApi(
  request: import('@playwright/test').APIRequestContext,
  creds: { email: string; username: string; password: string },
): Promise<{ userId: string; workspaceId: string }> {
  const res = await request.post(`${API_BASE}/auth/register`, {
    data: { email: creds.email, username: creds.username, password: creds.password },
  });
  expect([200, 201], `Register failed: ${await res.text()}`).toContain(res.status());
  
  await loginViaApi(request, creds.email, creds.password);

  const meRes = await request.get(`${API_BASE}/auth/me`);
  expect(meRes.status()).toBe(200);
  const meBody = (await meRes.json()) as { public_id: string };

  const wsRes = await request.get(`${API_BASE}/platform/workspaces/`);
  const wsBody = (await wsRes.json()) as { items?: Array<{ public_id: string }> };
  return { userId: meBody.public_id, workspaceId: wsBody.items?.[0]?.public_id ?? '' };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Voice Agent Widget / Capture Flow E2E', () => {

  test('VIEWER role is blocked from connecting to WebSocket', async ({ page }) => {
    const ownerCreds = makeCredentials('owner');
    const viewerCreds = makeCredentials('viewer');

    // 1. Register owner and viewer, invite viewer as a VIEWER role
    const { workspaceId } = await registerViaApi(page.request, ownerCreds);
    const { userId: viewerPublicId } = await registerViaApi(page.request, viewerCreds);

    await loginViaApi(page.request, ownerCreds.email, ownerCreds.password);
    const inviteRes = await page.request.post(`${API_BASE}/platform/workspaces/${workspaceId}/members`, {
      headers: await getHeaders(page.context()),
      data: { user_public_id: viewerPublicId, role: 'viewer' },
    });
    expect([200, 201]).toContain(inviteRes.status());

    // 2. Login as viewer and select shared workspace
    await loginViaApi(page.request, viewerCreds.email, viewerCreds.password);
    const selectRes = await page.request.post(`${API_BASE}/platform/workspaces/${workspaceId}/select`, {
      headers: await getHeaders(page.context()),
    });
    expect([200, 204]).toContain(selectRes.status());

    // 3. Open App and launch widget
    await page.goto('/');
    await expect(page.locator('#voice-agent-trigger')).toBeVisible();
    await page.locator('#voice-agent-trigger').click();

    // The backend should immediately close the WebSocket with ForbiddenError (handshake reject yields 1006 in browser)
    await expect(page.getByText('Session closed (1006).')).toBeVisible({ timeout: 10000 });
  });

  test('MEMBER gets provider unavailable alert when API key is missing', async ({ page }) => {
    const memberCreds = makeCredentials('member');
    await registerViaApi(page.request, memberCreds);

    await page.goto('/');
    await expect(page.locator('#voice-agent-trigger')).toBeVisible();
    await page.locator('#voice-agent-trigger').click();

    // The backend connects, but closes with code 4002 because VITE_GEMINI_API_KEY is not set
    await expect(page.getByText('Voice session needs attention')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Voice capture is temporarily unavailable. Please try again.')).toBeVisible();
  });

  test('MEMBER can submit text and trigger mock success events', async ({ page }) => {
    const memberCreds = makeCredentials('member');
    await registerViaApi(page.request, memberCreds);

    // Mock WebSocket on page context
    await page.addInitScript(() => {
      const OriginalWebSocket = window.WebSocket;
      class MockWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        url: string;
        readyState: number;
        binaryType: string;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: ((err: unknown) => void) | null;
        onclose: ((event: { code: number; reason: string }) => void) | null;

        constructor(url: string, protocols?: string | string[]) {
          this.url = url;
          this.readyState = 0; // CONNECTING
          this.binaryType = 'blob';
          this.onopen = null;
          this.onmessage = null;
          this.onerror = null;
          this.onclose = null;

          if (url.includes('/capture/agent/ws')) {
            (window as any).mockWSInstance = this;
            setTimeout(() => {
              this.readyState = 1; // OPEN
              if (this.onopen) this.onopen();
            }, 50);
          } else {
            return new OriginalWebSocket(url, protocols) as any;
          }
        }

        send(data: string) {
          if (typeof data === 'string') {
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'text') {
                // Mock transcript chunk
                setTimeout(() => {
                  this.triggerMessage({
                    type: 'transcript',
                    content: 'Creating a todo task for you.'
                  });
                }, 100);

                // Mock tool call
                setTimeout(() => {
                  this.triggerMessage({
                    type: 'tool_call',
                    name: 'create_todo_task',
                    arguments: { title: parsed.content }
                  });
                }, 300);

                // Mock tool call success response
                setTimeout(() => {
                  this.triggerMessage({
                    type: 'tool_response',
                    name: 'create_todo_task',
                    status: 'success',
                    result: { status: 'success', message: 'Task created' }
                  });
                }, 500);
              }
            } catch (e) {
              // ignore
            }
          }
        }

        close(code = 1000, reason = '') {
          this.readyState = 3; // CLOSED
          setTimeout(() => {
            if (this.onclose) this.onclose({ code, reason });
          }, 50);
        }

        triggerMessage(payload: unknown) {
          if (this.onmessage) {
            this.onmessage({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
          }
        }
      }

      window.WebSocket = MockWebSocket as any;
    });

    await page.goto('/');
    await page.locator('#voice-agent-trigger').click();

    // Verify widget opened and mocked connection is established
    await expect(page.getByText('Connected. Tap the microphone to talk.')).toBeVisible();

    // Send fallback message
    const input = page.locator('input[placeholder*="Type a message"]');
    await expect(input).toBeVisible();
    await input.fill('Write E2E test task');
    await input.press('Enter');

    // Assert user message is rendered
    await expect(page.getByText('Write E2E test task')).toBeVisible();

    // Assert agent transcript response is rendered
    await expect(page.getByText('Creating a todo task for you.')).toBeVisible();

    // Assert tool execution and success events are rendered in logs
    await expect(page.getByText('Voice agent is running create_todo_task...')).toBeVisible();
    await expect(page.getByText('Executed create_todo_task successfully.')).toBeVisible();
  });

  test('MEMBER receives and displays error event from WebSocket', async ({ page }) => {
    const memberCreds = makeCredentials('member');
    await registerViaApi(page.request, memberCreds);

    // Mock WebSocket to fail with a custom error message
    await page.addInitScript(() => {
      const OriginalWebSocket = window.WebSocket;
      class MockWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        url: string;
        readyState: number;
        binaryType: string;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: ((err: unknown) => void) | null;
        onclose: ((event: { code: number; reason: string }) => void) | null;

        constructor(url: string, protocols?: string | string[]) {
          this.url = url;
          this.readyState = 0; // CONNECTING
          this.binaryType = 'blob';
          this.onopen = null;
          this.onmessage = null;
          this.onerror = null;
          this.onclose = null;

          if (url.includes('/capture/agent/ws')) {
            (window as any).mockWSInstance = this;
            setTimeout(() => {
              this.readyState = 1; // OPEN
              if (this.onopen) this.onopen();
              
              // Trigger client error shortly after open
              setTimeout(() => {
                this.triggerMessage({
                  type: 'error',
                  message: 'Mock Voice limit reached'
                });
              }, 150);
            }, 50);
          } else {
            return new OriginalWebSocket(url, protocols) as any;
          }
        }

        send(data: string) {}

        close(code = 1000, reason = '') {
          this.readyState = 3; // CLOSED
          setTimeout(() => {
            if (this.onclose) this.onclose({ code, reason });
          }, 50);
        }

        triggerMessage(payload: unknown) {
          if (this.onmessage) {
            this.onmessage({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
          }
        }
      }

      window.WebSocket = MockWebSocket as any;
    });

    await page.goto('/');
    await page.locator('#voice-agent-trigger').click();

    // Verify custom error message is rendered in the messages panel
    await expect(page.getByText('Mock Voice limit reached')).toBeVisible({ timeout: 5000 });
  });

});
