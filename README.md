# Lifestack End-to-End (E2E) Test Suite

This repository contains the standalone Playwright-based end-to-end integration test suite for the Lifestack platform. It runs automated user flows against an isolated multi-container staging environment.

## Architecture

The staging environment is orchestrated using Docker Compose (`docker-compose.e2e.yml`) and consists of:

- **Database (`postgres`)**: PostgreSQL 18 instance running on host port `5433` (internal port `5432`).
- **Cache (`redis`)**: Redis 7-alpine instance running on host port `6381` (internal port `6379`).
- **Backend API (`api-e2e`)**: FastAPI server running on host port `8001` (internal port `8000`), automatically connected to Postgres and Redis.
- **Frontend UI (`web-e2e`)**: Vite/React server running on host port `5174` (internal port `5173`) running in `--mode e2e`.

---

## Getting Started

### 1. Prerequisites
Ensure you have Docker and Node.js (v20+) installed on your machine.

### 2. Stand Up the Staging Stack
From the `lifestack-e2e` directory, start the containers in detached mode:
```bash
docker compose -f docker-compose.e2e.yml up -d --build
```

### 3. Run Database Migrations
Once Postgres is up, run the database migrations on the `api-e2e` container:
```bash
docker compose -f docker-compose.e2e.yml exec api-e2e alembic upgrade head
```

### 4. Run the Test Suite
Execute the Playwright integration tests:
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

## Test Coverage

- **`e2e/auth.spec.ts`**: Registration, login, automatic sidebar category provisioning, protected routes redirection, and session logout.
- **`e2e/spending-guardrails.spec.ts`**: Category creation, budget setting, logging breacheable expense transaction (95%), triggering backend guardrail evaluation task, and verifying the todo alert generation.
- **`e2e/spending-recurring.spec.ts`**: Recurring spending rule creation/edit/deactivation and scheduler-driven recurring transaction generation verification.
- **`e2e/investing-fx.spec.ts`**: Multi-currency brokerage accounts creation (GBP & USD), holding asset creation, setting reporting currency (USD), checking valuation, and look-through exposure analytics.
- **`e2e/exports.spec.ts`**: JSON and CSV/Zip data export requests, status polling, and download integrity verification.
