/**
 * Voice Agent Widget / Capture Flow E2E Verification Suite
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { retryUnauthorized } from './helpers/api';
import { apiV1, csrfHeaders } from './helpers/test-helpers';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCredentials(role: string) {
  const ts = Date.now();
  return {
    email: `e2e-capture-${role}-${ts}@example.com`,
    username: `capture_${role}_${ts}`,
    password: 'Password123!',
  };
}

async function loginViaApi(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const params = new URLSearchParams({ username: email, password });
  let lastRes: import('@playwright/test').APIResponse | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    lastRes = await request.post(`${apiV1()}/auth/login`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: params.toString(),
    });
    if (lastRes.status() === 200) {
      await retryUnauthorized(() => request.get(`${apiV1()}/auth/me`));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  expect(lastRes, `Login request was not attempted for ${email}`).toBeDefined();
  expect(lastRes!.status(), `Login failed for ${email}: ${await lastRes!.text()}`).toBe(200);
}

async function registerViaApi(
  request: APIRequestContext,
  creds: { email: string; username: string; password: string },
): Promise<{ userId: string; workspaceId: string }> {
  const res = await request.post(`${apiV1()}/auth/register`, {
    data: { email: creds.email, username: creds.username, password: creds.password },
  });
  expect([200, 201], `Register failed: ${await res.text()}`).toContain(res.status());
  
  await loginViaApi(request, creds.email, creds.password);
 
  const meRes = await retryUnauthorized(() => request.get(`${apiV1()}/auth/me`));
  expect(meRes.status()).toBe(200);
  const meBody = (await meRes.json()) as { public_id: string };

  const wsRes = await retryUnauthorized(
    () => request.get(`${apiV1()}/platform/workspaces/`),
  );
  expect(wsRes.status()).toBe(200);
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
    const inviteRes = await page.request.post(`${apiV1()}/platform/workspaces/${workspaceId}/members`, {
      headers: await csrfHeaders(page.context()),
      data: { user_public_id: viewerPublicId, role: 'viewer' },
    });
    expect([200, 201]).toContain(inviteRes.status());

    // 2. Login as viewer and select shared workspace
    await loginViaApi(page.request, viewerCreds.email, viewerCreds.password);
    const selectRes = await page.request.post(`${apiV1()}/platform/workspaces/${workspaceId}/select`, {
      headers: await csrfHeaders(page.context()),
    });
    expect([200, 204]).toContain(selectRes.status());

    // 3. Open App and launch widget
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#voice-agent-trigger')).toBeVisible({ timeout: 10_000 });
    await page.locator('#voice-agent-trigger').click();

    // Trigger lazy WS connection by focusing the input
    const input = page.locator('input[placeholder*="Type a message"]');
    await expect(input).toBeVisible();
    await input.focus();

    // The backend accepts the handshake and closes 4003 (policy violation) for
    // forbidden roles (api issue #199) — the client treats 4003 as terminal and
    // does not retry, so the session-closed message appears immediately.
    await expect(page.getByText('Session closed (4003).')).toBeVisible({ timeout: 10000 });
  });

  // The composed e2e stack (docker-compose.e2e.yml) does not provision a
  // GEMINI_API_KEY, so a real connection attempt always hits the backend's
  // graceful-degradation path (app/capture/agent.py run_agent_session) rather
  // than actually reaching Gemini. That path is itself real, deterministic
  // behavior worth asserting on — this is not the mocked-WebSocket path used
  // by the other tests in this file.
  test('MEMBER sees a graceful error when the voice provider is unavailable', async ({ page }) => {
    const memberCreds = makeCredentials('member');
    await registerViaApi(page.request, memberCreds);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#voice-agent-trigger')).toBeVisible({ timeout: 10_000 });
    await page.locator('#voice-agent-trigger').click();

    // Trigger lazy WS connection by focusing the input
    const input = page.locator('input[placeholder*="Type a message"]');
    await expect(input).toBeVisible();
    await input.focus();

    // With no GEMINI_API_KEY, the backend closes the unavailable provider
    // session and the client exposes its reconnecting status.
    await expect(
      page.getByRole('alert').getByText(/Connection lost — reconnecting/),
    ).toBeVisible({ timeout: 10000 });

    // UX Review Part 2 #7: Status must converge to one truthful status line rather than a stack of contradictory logs
    const statusLogs = page.locator('[data-testid="voice-status-log-item"]');
    if (await statusLogs.count() > 0) {
      expect(await statusLogs.count()).toBeLessThanOrEqual(1);
    }
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

                // Mock tool call success response — spec-066's confirmation-card
                // contract: entity_type/entity_public_id/summary drive the card
                // (see VoiceAgentWidget.tsx CONFIRMATION_CARD_REGISTRY); a bare
                // success with no entity_type renders no card at all.
                setTimeout(() => {
                  this.triggerMessage({
                    type: 'tool_response',
                    name: 'create_todo_task',
                    status: 'success',
                    result: {
                      status: 'success',
                      entity_type: 'todo',
                      entity_public_id: 'abc-123-uuid',
                      summary: `Added todo '${parsed.content}'`
                    }
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

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('#voice-agent-trigger').click();

    // Trigger lazy WS connection by focusing the input
    const input = page.locator('input[placeholder*="Type a message"]');
    await expect(input).toBeVisible();
    await input.focus();

    // Verify widget opened and mocked connection is established
    await expect(page.getByText('Connected. Tap the microphone to talk or type a message.')).toBeVisible();

    // Send fallback message
    await input.fill('Write E2E test task');
    await input.press('Enter');

    // Assert user message is rendered
    await expect(page.getByText('Write E2E test task')).toBeVisible();

    // Assert agent transcript response is rendered
    await expect(page.getByText('Creating a todo task for you.')).toBeVisible();

    // Assert confirmation card and link are rendered instead of plain log messages
    const card = page.getByTestId('confirmation-card');
    await expect(card).toBeVisible();
    await expect(card.getByText('Todo', { exact: true })).toBeVisible();
    await expect(card.getByText("Added todo 'Write E2E test task'")).toBeVisible();
    const viewLink = card.getByRole('link', { name: 'View →' });
    await expect(viewLink).toBeVisible();
    await expect(viewLink).toHaveAttribute('href', '/todo?id=abc-123-uuid');
  });

  test('MEMBER can find, confirm, and update a spending transaction', async ({ page }) => {
    const memberCreds = makeCredentials('transaction-correction');
    await registerViaApi(page.request, memberCreds);

    await page.addInitScript(() => {
      const OriginalWebSocket = window.WebSocket;
      class MockWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        url: string;
        readyState = 0;
        binaryType = 'blob';
        onopen: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: ((err: unknown) => void) | null = null;
        onclose: ((event: { code: number; reason: string }) => void) | null = null;

        constructor(url: string, protocols?: string | string[]) {
          this.url = url;
          if (!url.includes('/capture/agent/ws')) {
            return new OriginalWebSocket(url, protocols) as any;
          }
          setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.();
          }, 50);
        }

        send(data: string) {
          const parsed = JSON.parse(data) as { type?: string; content?: string };
          if (parsed.type !== 'text') return;

          const confirming = (parsed.content || '').toLowerCase().includes('yes');
          if (!confirming) {
            setTimeout(() => {
              this.triggerMessage({
                type: 'transcript',
                content: 'I found one lunch transaction for $25. Please confirm the change to $30.',
              });
              this.triggerMessage({
                type: 'tool_call',
                name: 'find_spending_transactions',
                arguments: { from_day: '2026-08-22', search: 'lunch' },
              });
              this.triggerMessage({
                type: 'tool_response',
                name: 'find_spending_transactions',
                status: 'success',
                result: {
                  status: 'success',
                  total: 1,
                  transactions: [{ entity_public_id: 'tx-123', amount: '25.00' }],
                },
              });
            }, 150);
            return;
          }

          setTimeout(() => {
            this.triggerMessage({
              type: 'tool_call',
              name: 'update_spending_transaction',
              arguments: { public_id: 'tx-123', amount: '30.00', confirmed: true },
            });
            this.triggerMessage({
              type: 'tool_response',
              name: 'update_spending_transaction',
              status: 'success',
              result: {
                status: 'success',
                entity_type: 'transaction',
                entity_public_id: 'tx-123',
                summary: 'Updated spending transaction tx-123',
              },
            });
          }, 150);
        }

        close(code = 1000, reason = '') {
          this.readyState = MockWebSocket.CLOSED;
          this.onclose?.({ code, reason });
        }

        triggerMessage(payload: unknown) {
          this.onmessage?.({
            data: typeof payload === 'string' ? payload : JSON.stringify(payload),
          });
        }
      }

      window.WebSocket = MockWebSocket as any;
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('#voice-agent-trigger').click();
    const input = page.locator('input[placeholder*="Type a message"]');
    await expect(input).toBeVisible();
    await input.focus();

    await input.fill('Find my lunch transaction and correct it to 30 dollars');
    await input.press('Enter');
    await expect(page.getByText(/I found one lunch transaction/)).toBeVisible();

    await input.fill('Yes, update it');
    await input.press('Enter');
    const card = page.getByTestId('confirmation-card');
    await expect(card).toBeVisible();
    await expect(card.getByText('Spending', { exact: true })).toBeVisible();
    await expect(card.getByText('Updated spending transaction tx-123')).toBeVisible();
    await expect(card.getByRole('link', { name: 'View →' })).toHaveAttribute(
      'href',
      '/spending/transactions',
    );
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

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('#voice-agent-trigger').click();

    // Trigger lazy WS connection by focusing the input
    const input = page.locator('input[placeholder*="Type a message"]');
    await expect(input).toBeVisible();
    await input.focus();

    // Verify custom error message is rendered in the messages panel
    await expect(page.getByText('Mock Voice limit reached')).toBeVisible({ timeout: 5000 });
  });

  test('renders confirmation cards for typed ordinary income and capital transfers', async ({ page }) => {
    const memberCreds = makeCredentials('member');
    await registerViaApi(page.request, memberCreds);

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
          this.readyState = 0;
          this.binaryType = 'blob';
          this.onopen = null;
          this.onmessage = null;
          this.onerror = null;
          this.onclose = null;

          if (url.includes('/capture/agent/ws')) {
            (window as any).mockWSInstance = this;
            setTimeout(() => {
              this.readyState = 1;
              if (this.onopen) this.onopen();
            }, 50);
          } else {
            return new OriginalWebSocket(url, protocols) as any;
          }
        }

        send(data: string) {
          setTimeout(() => {
            const parsed = JSON.parse(data);
            const userText =
              parsed?.content || parsed?.realtimeInput?.mediaChunks?.[0]?.data || '';
            const normalizedText = String(userText).toLowerCase();
            if (normalizedText.includes('salary') || normalizedText.includes('income')) {
              this.triggerMessage({
                serverContent: {
                  modelTurn: {
                    parts: [
                      {
                        functionCall: {
                          name: 'log_spending_transaction',
                          args: {
                            amount: '3500.00',
                            category_name: 'salary',
                            description: 'Monthly salary',
                            transaction_type: 'income',
                          },
                        },
                      },
                    ],
                  },
                },
              });
              this.triggerMessage({
                type: 'tool_response',
                name: 'log_spending_transaction',
                status: 'success',
                result: {
                  status: 'success',
                  entity_type: 'transaction',
                  entity_public_id: 'tx-inc-999',
                  type: 'income',
                  amount: '3500.00',
                  category: 'salary',
                  description: 'Monthly salary',
                  summary: "Added $3500.00 'Monthly salary' to Spending",
                },
              });
            } else if (normalizedText.includes('transfer')) {
              this.triggerMessage({
                serverContent: {
                  modelTurn: {
                    parts: [
                      {
                        functionCall: {
                          name: 'create_transfer',
                          args: {
                            from_account_name: 'Checking',
                            to_account_name: 'Brokerage',
                            amount: '500.00',
                            confirmed: true,
                          },
                        },
                      },
                    ],
                  },
                },
              });
              this.triggerMessage({
                type: 'tool_response',
                name: 'create_transfer',
                status: 'success',
                result: {
                  status: 'success',
                  entity_type: 'capital_transfer',
                  entity_public_id: 'tr-555',
                  transfer: {
                    entity_public_id: 'tr-555',
                    from_account_name: 'Checking',
                    to_account_name: 'Brokerage',
                    gross_amount: '500.00',
                    net_amount_received: '500.00',
                  },
                  summary: 'Transferred 500.00 USD from Checking to Brokerage',
                },
              });
            }
          }, 150);
        }

        close(code = 1000, reason = '') {
          this.readyState = 3;
          this.onclose?.({ code, reason });
        }

        triggerMessage(payload: unknown) {
          if (this.onmessage) {
            this.onmessage({
              data: typeof payload === 'string' ? payload : JSON.stringify(payload),
            });
          }
        }
      }

      window.WebSocket = MockWebSocket as any;
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('#voice-agent-trigger').click();
    const input = page.locator('input[placeholder*="Type a message"]');
    await expect(input).toBeVisible();
    await input.focus();

    // 1. Income capture contract
    await input.fill('Log my monthly salary of 3500');
    await input.press('Enter');
    const incomeCard = page.getByTestId('confirmation-card').filter({ hasText: 'Monthly salary' });
    await expect(incomeCard).toBeVisible();
    await expect(incomeCard.getByText("Added $3500.00 'Monthly salary' to Spending")).toBeVisible();
    await expect(incomeCard.getByRole('link', { name: 'View →' })).toHaveAttribute(
      'href',
      '/spending/transactions',
    );

    // 2. Transfer capture contract
    await input.fill('Transfer 500 from checking to brokerage');
    await input.press('Enter');
    const transferCard = page.getByTestId('confirmation-card').filter({ hasText: 'Transferred 500.00 USD' });
    await expect(transferCard).toBeVisible();
    await expect(transferCard.getByRole('link', { name: 'View →' })).toHaveAttribute(
      'href',
      '/spending/account-activity',
    );
  });
});
