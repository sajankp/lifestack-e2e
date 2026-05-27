# Security and E2E Reliability Checklist

Checklist for integration test environment and security-sensitive flow coverage.

## Environment and Isolation
- [ ] E2E stack runs in isolated compose network and database.
- [ ] Test credentials/data are synthetic and disposable.
- [ ] `docker compose ... down -v` used after runs to clear state.

## Auth and Session Flows
- [ ] Registration/login/logout path is covered by Playwright (`auth.spec.ts`).
- [ ] Protected-route behavior is validated in browser flows.

## Cross-Module High-Risk Flows
- [ ] Budget guardrails flow validates workflow-triggered todo creation.
- [ ] Recurring generation flow validates scheduler-created transactions.
- [ ] Export flow validates authenticated download lifecycle.

## Harness Safety
- [ ] API and Web URLs are passed through env, not hardcoded to production hosts.
- [ ] Compose config validation passes before execution.
- [ ] Playwright suite discovery remains stable.

## Verification Log (2026-05-28)
- Harness checks passed:
  - `docker compose -f docker-compose.e2e.yml config -q`
  - `npx playwright test --list` (6 tests discovered)
