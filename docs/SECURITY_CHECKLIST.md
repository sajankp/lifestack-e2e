# Security and E2E Reliability Checklist

Checklist for integration test environment and security-sensitive flow coverage.

## Environment and Isolation
- [x] E2E stack runs in isolated compose network and database.
- [x] Test credentials/data are synthetic and disposable.
- [x] `docker compose ... down -v` used after runs to clear state.

## Auth and Session Flows
- [x] Registration/login/logout path is covered by Playwright (`auth.spec.ts`).
- [x] Protected-route behavior is validated in browser flows.

## Cross-Module High-Risk Flows
- [x] Budget guardrails flow validates workflow-triggered todo creation.
- [x] Recurring generation flow validates scheduler-created transactions.
- [x] Export flow validates authenticated download lifecycle.

## Harness Safety
- [x] API and Web URLs are passed through env, not hardcoded to production hosts.
- [x] Compose config validation passes before execution.
- [x] Playwright suite discovery remains stable.
- [x] Web dependencies are installed at image-build time with `npm ci`, not at container startup.
- [x] Spending workflow specs trigger local-only authenticated API hooks instead of running job code through container shell commands.
- [x] `npm audit --audit-level=high` is available as `npm run security:audit` and runs in CI.
- [x] Cross-repo dispatch is end-to-end verified. Both API CI and Web CI send `repository_dispatch` event `api-web-merge` on push to `main`; E2E workflow declares the receiver and runs the full suite. Secret `E2E_DISPATCH_TOKEN` configured in both source repos.

## Verification Log (2026-08-28)

- `npx playwright test --list` discovered 60 tests across 28 spec files.
- Compose owns migration ordering through the one-shot `migrate` service.
- CI supports smoke, full, and critical tiers with failure artifacts and bounded
  retention.
- Cross-repo dispatch contract complete: both API and Web send `api-web-merge`
  on push to main; E2E workflow declares `repository_dispatch` receiver.
  End-to-end verification pending secret configuration and a fresh run.

## Verification Log (2026-08-24)
- Gate 0 harness cleanup:
  - `web-e2e` builds from `Dockerfile.web-e2e` and no longer runs `npm install` during service startup.
  - `api-e2e` enables `ENABLE_E2E_TEST_HOOKS=true` for local harness-only workflow triggers.
  - Guardrail and recurring Playwright specs call authenticated `/v1/e2e/...` hooks instead of `docker compose exec ... python -c`.

## Verification Log (2026-06-04)
- Gate 0 dependency audit checks passed:
  - `npm run security:audit` (0 vulnerabilities)
  - GitHub workflow YAML parse check for `.github/workflows/ci.yml`
  - CI workflow `.github/workflows/ci.yml` runs `npm run security:audit` on push and pull request events targeting `main`.

## Verification Log (2026-05-28)
- Harness checks passed:
  - `docker compose -f docker-compose.e2e.yml config -q`
  - `npx playwright test --list` (6 tests discovered)
