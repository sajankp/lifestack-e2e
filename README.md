# Lifestack End-to-End (E2E) Test Suite

This repository contains the standalone Playwright-based end-to-end integration test suite for the Lifestack platform. It runs automated user flows against an isolated multi-container staging environment.

## Architecture

The staging environment is orchestrated using Docker Compose (`docker-compose.e2e.yml`) and consists of:

- **Database (`postgres`)**: PostgreSQL 18 instance running on host port `5433` (internal port `5432`).
- **Cache (`redis`)**: Redis 7-alpine instance running on host port `6381` (internal port `6379`).
- **Backend API (`api-e2e`)**: FastAPI server running on host port `8001` (internal port `8000`), automatically connected to Postgres and Redis.
- **Frontend UI (`web-e2e`)**: Vite/React server running on host port `5174` (internal port `5173`) from a clean image built with `npm ci`, running in `--mode e2e`.

---

## Getting Started

### 1. Prerequisites
Ensure you have Docker and Node.js (v20+) installed on your machine.

### 2. Stand Up the Staging Stack
From the `lifestack-e2e` directory, use the repo-managed bootstrap:
```bash
npm run stack:up
```

This builds the API and web images, starts Postgres/Redis, runs migrations, seeds deterministic FX data, and executes the precheck.

Manual compose startup remains available for debugging:
```bash
docker compose -f docker-compose.e2e.yml up -d --build
```

### 3. Run Environment Precheck
Run a fail-fast precheck for Web/API/DB connectivity:
```bash
PLAYWRIGHT_BASE_URL=http://localhost:5174 \
PLAYWRIGHT_API_URL=http://localhost:8001 \
E2E_DATABASE_URL=postgresql+asyncpg://lifestack_e2e:lifestack_e2e@localhost:5433/lifestack_e2e \
npm run precheck
```

### 4. Run Smoke Suite (must-pass)
Run the fast smoke tier:
```bash
PLAYWRIGHT_BASE_URL=http://localhost:5174 \
PLAYWRIGHT_API_URL=http://localhost:8001 \
E2E_DATABASE_URL=postgresql+asyncpg://lifestack_e2e:lifestack_e2e@localhost:5433/lifestack_e2e \
npm run test:smoke
```

Single-command orchestration is also available:
```bash
npm run test:smoke:stack
```

### 5. Run Full Suite
Execute all Playwright integration tests:
```bash
PLAYWRIGHT_BASE_URL=http://localhost:5174 \
PLAYWRIGHT_API_URL=http://localhost:8001 \
E2E_DATABASE_URL=postgresql+asyncpg://lifestack_e2e:lifestack_e2e@localhost:5433/lifestack_e2e \
npm run test:full
```

Single-command orchestration is also available:
```bash
npm run test:full:stack
```

### 6. Tear Down the Environment
To stop the containers and delete the volumes (wiping the database):
```bash
docker compose -f docker-compose.e2e.yml down -v
```

Equivalent repo-managed teardown:
```bash
npm run stack:down
```

---

## Test Coverage

- **`e2e/auth.spec.ts`**: Registration, login, automatic sidebar category provisioning, protected routes redirection, and session logout.
- **`e2e/todo-smoke.spec.ts`**: Todo creation and completion smoke flow.
- **`e2e/imports-smoke.spec.ts`**: Spending import validate + commit smoke flow.
- **`e2e/spending-guardrails.spec.ts`**: Category creation, budget setting, logging breacheable expense transaction (95%), triggering the local-only E2E guardrail hook over HTTP, and verifying the todo alert generation.
- **`e2e/spending-recurring.spec.ts`**: Recurring spending rule creation/edit/deactivation and local-only E2E recurring generation hook verification.
- **`e2e/investing-fx.spec.ts`**: Multi-currency brokerage accounts creation (GBP & USD), holding asset creation, setting reporting currency (USD), checking valuation, and look-through exposure analytics.
- **`e2e/runtime-header-master-config.spec.ts`**: Global header verification (notification icon + logout) and Master Configuration edit actions for accounts and categories.
- **`e2e/exports.spec.ts`**: JSON and CSV/Zip data export requests, status polling, and download integrity verification.
- **`e2e/finance-display-settings.spec.ts`**: Workspace/user finance display preference behavior on dashboard totals.
- **`e2e/rbac.spec.ts`**: Workspace role enforcement for transactions, todos, and finance settings.

The current suite contains 14 specs across 10 files. It is the source of truth for full-stack smoke coverage; repo-local frontend Playwright tests remain frontend-only.

The API compose service enables `ENABLE_E2E_TEST_HOOKS=true` only inside this local harness. Specs must trigger background workflows through those authenticated HTTP hooks instead of shelling into containers.

## Security Checklist

Release hardening and harness safety checks are tracked in [docs/SECURITY_CHECKLIST.md](docs/SECURITY_CHECKLIST.md).
