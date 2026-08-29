# Lifestack End-to-End (E2E) Test Suite

This repository contains the standalone Playwright-based end-to-end integration test suite for the Lifestack platform. It runs automated user flows against an isolated multi-container staging environment.

Current verified inventory (2026-08-24): `npx playwright test --list` discovers
**60 tests across 28 spec files**.

## Architecture

The staging environment is orchestrated using Docker Compose (`docker-compose.e2e.yml`) and consists of:

- **Database (`postgres`)**: PostgreSQL 18 instance running on host port `5433` (internal port `5432`).
- **Cache (`redis`)**: Redis 7-alpine instance running on host port `6381` (internal port `6379`).
- **Backend API (`api-e2e`)**: FastAPI server running on host port `8001` (internal port `8000`), automatically connected to Postgres and Redis.
- **Frontend UI (`web-e2e`)**: Vite/React server running on host port `5174` (internal port `5173`) serving the production build via `npm run preview` (verifies build artifacts).

---

## Getting Started

### 1. Prerequisites
Ensure you have Docker and Node.js (v20+) installed on your machine.

### 2. Stand Up the Staging Stack
From the `lifestack-e2e` directory, start the containers in detached mode:
```bash
docker compose -f docker-compose.e2e.yml up -d --build
```

### 3. Database Migrations
The Compose stack runs `alembic upgrade head` in a one-shot `migrate` service.
The API waits for that service to complete successfully before starting, so
the stack is ready for tests after `up` returns.

### 4. Run the Test Suite

Prefer the npm scripts over hand-assembling `playwright test` — they wrap the
env vars above and gate on `precheck` (verifies the stack is actually up
before spending time on a doomed run):

```bash
npm run test:smoke        # @smoke-tagged subset only, assumes stack is already running + env vars set
npm run test:full         # full suite, assumes stack is already running + env vars set
npm run test:critical     # @critical-tagged subset (core flows), assumes stack is already running + env vars set
npm run test:local        # full suite against the standard local ports (sets env vars for you)
npm run test:local:smoke  # @smoke subset against the standard local ports
npm run test:local:critical # @critical subset against the standard local ports
npm run test:smoke:stack  # brings the stack up, runs @smoke, tears it down
npm run test:full:stack   # brings the stack up, runs the full suite, tears it down
```

On hosts where Playwright cannot download its bundled browser, point the suite
at an installed Chrome binary:
```bash
PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:smoke:stack
```

Other scripts:
- `npm run precheck` — verifies the composed stack (web/api/db) is reachable before a run.
- `npm run stack:up` / `npm run stack:down` — bring the composed stack up/down without running tests.
- `npm run security:audit` — `npm audit --audit-level=high`.

If you want to invoke Playwright directly instead:
```bash
PLAYWRIGHT_BASE_URL=http://localhost:5174 \
PLAYWRIGHT_API_URL=http://localhost:8001 \
E2E_DATABASE_URL=postgresql+asyncpg://lifestack_e2e:lifestack_e2e@localhost:5433/lifestack_e2e \
npx playwright test
```

### 5. Tear Down the Environment
To stop the containers and delete the volumes (wiping the database):
```bash
docker compose -f docker-compose.e2e.yml down -v
```

---

## Demo tooling

Two additional pieces of tooling support recording a reviewer-facing demo video, separate from the test suite:

- **`docker-compose.demo.yml`**: an overlay on top of `docker-compose.e2e.yml` that sets `ENABLE_DEMO_RESET=true` on `api-e2e`, exposing the demo-reset endpoint used to seed a clean guided-tour dataset:
  ```bash
  docker compose -f docker-compose.e2e.yml -f docker-compose.demo.yml up -d --build
  ```
- **`scripts/record-demo.mjs`**: drives a scripted guided tour (dashboard -> spending -> imports -> investing -> workspace/master config) with on-screen captions and records it as a video via Playwright's `chromium` launcher. Run after the demo-enabled stack is up:
  ```bash
  node scripts/record-demo.mjs [output-dir]
  ```

---

## CI

`.github/workflows/ci.yml` runs two jobs on every push/PR to `main`: a
dependency/secret-scan job, and `e2e-tests`, which composes the same stack
described above (`docker-compose.e2e.yml`, building `lifestack-api` and
`lifestack-web` from their `main` branches as sibling checkouts) and runs the
suite against it.

**What runs when:**
- **Pull requests**: `npm run test:local:smoke` — the `@smoke`-tagged subset only, for fast PR feedback.
- **Push to `main`**, the **nightly cron** (03:00 UTC): `npm run test:local` — the full suite (artifacts retained 7 days).
- **Manual `workflow_dispatch`** (default `full`, or pick `smoke`, `critical`): runs the selected suite (artifacts retained 30 days).
- **Critical-path validation**: `workflow_dispatch` with `suite=critical` runs `@critical`-tagged tests for fast regression checks.

**Flakiness budget**: `playwright.config.ts` sets `retries: 1` globally. A
spec that still fails after that retry in CI is a real regression, not noise —
file a GitHub issue and leave a `// TODO(#issue): ...` comment on the spec
rather than adding more retries or skipping it silently.

**Artifacts**: on failure, the Playwright HTML report (`playwright-report/`)
and raw `test-results/` (screenshots + traces) are uploaded as the
`playwright-report` artifact. Open the HTML report locally with
`npx playwright show-report path/to/downloaded/playwright-report`, or a
specific trace with `npx playwright show-trace path/to/trace.zip`.

**Artifact retention**: PR/on-demand runs retain for 30 days; nightly cron runs retain for 7 days.
A weekly cleanup workflow (`.github/workflows/cleanup-artifacts.yml`) removes stale artifacts.

**Cross-repo triggering — contract complete**: Both API CI and Web CI now send event `api-web-merge` to this repository on push to `main` using `E2E_DISPATCH_TOKEN`. This workflow declares the `repository_dispatch` receiver, so cross-repo merges trigger a full E2E run. Manual `workflow_dispatch` and nightly cron remain available as backstops.

---

## Test Coverage

- **`e2e/auth.spec.ts`** `@smoke`: Registration, login, automatic sidebar category provisioning, protected routes redirection, and session logout.
- **`e2e/spending-guardrails.spec.ts`** `@smoke`: Category creation, budget setting, logging breachable expense transaction (95%), triggering backend guardrail evaluation task, and verifying the todo alert generation.
- **`e2e/spending-recurring.spec.ts`**: Recurring spending rule creation/edit/deactivation and scheduler-driven recurring transaction generation verification.
- **`e2e/investing-fx.spec.ts`**: Multi-currency brokerage accounts creation (GBP & USD), holding asset creation, setting reporting currency (USD), checking valuation, and look-through exposure analytics.
- **`e2e/investing-orders.spec.ts`**: Buy/sell order placement, weighted-average cost basis, realized gain/loss, FIFO lot consumption across buys, insufficient-cash rejection, order deletion/recompute, trade history, and transfer-triggered cash entries.
- **`e2e/runtime-header-master-config.spec.ts`**: Global header verification (notifications + profile menu) and Settings edit actions for accounts and categories.
- **`e2e/exports.spec.ts`** `@smoke`: JSON and CSV/Zip data export requests, status polling, and download integrity verification.
- **`e2e/imports-smoke.spec.ts`** `@smoke`: Import validation and commit for a spending import, plus rolling back a completed import from the UI.
- **`e2e/rbac.spec.ts`** `@rbac`: Role-based access enforcement — VIEWER blocked from creating transactions/modifying finance settings, MEMBER can create/read todos, OWNER can modify workspace finance settings.
- **`e2e/workspace-isolation.spec.ts`**: Switching visible workspace data and blocking cross-workspace todo/spending lookups.
- **`e2e/capture.spec.ts`**: Voice agent widget/capture flow — VIEWER blocked from the WebSocket, MEMBER connects and submits text triggering mock success events, and error-event display.
- **`e2e/todo-smoke.spec.ts`** `@smoke`: Creating a timed todo for today and completing it.
- **`e2e/transfer-flow.spec.ts`**: Same-currency and cross-currency transfer creation, and rejection of invalid transfer arithmetic.
- **`e2e/app-shell-responsive.spec.ts`**: Tablet navigation, profile menu, notifications, and logout in the responsive app shell.
- **`e2e/finance-display-settings.spec.ts`**: Workspace currency-code display followed by a user-level symbol override applied to dashboard totals.
- **`e2e/guided-empty-states.spec.ts`**: First-run empty states and primary actions across core modules.
- **`e2e/keyboard-accessibility.spec.ts`**: Keyboard-only navigation through the sidebar, Todo creation/completion, and the Spending category modal.
- **`e2e/notifications-summaries.spec.ts`**: Weekly summary notification rendering/read-state, and notification/summary isolation across workspace switches.
- **`e2e/spending-kpis.spec.ts`** `@smoke`: Custom financial KPI creation with a target, breach detection against logged spend, surfacing on the dashboard card, and deletion.
- **`e2e/statement-reconciliation.spec.ts`** `@smoke`: Bank statement CSV import against a wallet account and matching an unmatched statement line to an existing transaction.
- **`e2e/investing-dividends-corporate-actions.spec.ts`** `@smoke`: Recording and deleting a dividend/income entry, and recording and deleting a stock split corporate action.
- **`e2e/investing-return-metrics-historical-data.spec.ts`**: Investing return metrics panel (open/exited position toggle) and Net Worth historical-data backfill import + deletion.
- **`e2e/health.spec.ts`** `@smoke`: Medication creation, late/missed/pending dose handling, dose/weight logging, and briefing integration.
- **`e2e/investing-analytics.spec.ts`**: Asset-allocation analytics and warning deduplication.
- **`e2e/performance-caching.spec.ts`**: ETag/304 behavior, transfer pagination bounds, and optimistic cache removal.
- **`e2e/pwa-offline.spec.ts`**: Web manifest and authenticated offline-state behavior.
- **`e2e/spending-analytics.spec.ts`**: Category palette and savings-rate analytics.
- **`e2e/weekly-summaries.spec.ts`**: Summary stale indicator and bounded movement rendering.

The capture suite also covers spec-093's find -> confirm -> update transaction
flow. MCP spec-094 is API-contract tested; it does not yet have a browser E2E
because the primary client is external to the Web application.
