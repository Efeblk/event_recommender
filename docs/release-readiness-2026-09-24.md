# Release readiness — 24 September 2026

This is a local release audit, not a deployment or approval to purchase services.
The user selected free-first development and staging. The generated deployment
configuration now defaults to `WORKERS_PLAN=free`; the paid CPU allowance requires
an explicit `WORKERS_PLAN=paid`. Neither setting changes the account subscription.

## Local evidence

- The new frozen 20-case release regression set covers Turkish/English dates,
  follow-up corrections, shared budgets, genres, mandatory venue evidence and
  provider merging. Its offline interpretation gate passes without provider calls.
  Live result verification is recorded separately; parser success does not prove
  recommendation relevance.
- The compiled Worker smoke exercises isolated D1/R2, authenticated imports,
  restart recovery, checkpoints, readiness and embedding-cache coverage. The
  Voyage stalled-response test also passes.
- Headless Chromium checks run against the compiled application with API mocks
  and external images blocked. Eleven checks pass across desktop and 375px mobile:
  hydration, offers, privacy, submission, history, retry, rate limits, reset races,
  keyboard focus and layout. One project-inapplicable mobile-layout case is skipped.
  These tests spend no provider credit and now run in CI.
- Real local catalog pages were also rendered at 1440px and 375px with no uncaught
  browser errors or horizontal overflow. T3Code's preview automation host was
  unavailable; headless Chromium was used without controlling the desktop.
- Full-catalog Node profiling reduced median CPU by 60–67% through cached timezone
  formatters and avoiding unused filter work. See [deployment measurements](deployment.md).
  This is not Cloudflare CPU or memory telemetry and does not establish Free-plan
  capacity. No catalog truncation or embedding-dimension reduction was introduced.
- Rollback verification now checks that the requested Worker version receives all
  traffic before accepting its environment health response. A healthy old version
  is no longer sufficient evidence of a successful rollback.

## Dependency review

The Cloudflare build adapter, Wrangler and matching Worker types were updated;
the collector lockfile update removed the reported high-severity `adm-zip` issue.
The remaining audit findings are moderate, with no high or critical findings:

- Web: four dependency-chain entries rooted in the development-only Drizzle Kit
  esbuild development-server advisory, GHSA-67mh-4wv8-2f99. Production dependencies
  have no reported vulnerabilities. No esbuild development server is published.
  npm's suggested downgrade is not applied because it is a breaking older Drizzle
  release rather than a compatible fix.
- Collector: three entries in the Crawlee/stream-json chain for
  GHSA-528h-pc64-c93x. The installed Crawlee path uses `StreamArray.withParser()`
  for serialized arrays; the advisory names the pick/ignore/filter/replace filters.
  No direct use of those filters was found in that path. npm reports no fix.
  This inspection is scoped, not a guarantee about every transitive path; revisit
  on dependency upgrades and keep collection isolated from public request serving.

## Outstanding account and elapsed-time gates

The audit found R2 disabled and no GitHub staging/production environments. The
existing unrelated D1 database must not be reused. Preparing the application does
not enable billing, create public endpoints, or configure account secrets.

Before release, finish the account resources and protected deployment settings,
bootstrap staging, measure the complete catalog on the selected Worker plan,
exercise remote rollback/D1 restore/R2 recovery, and collect at least 48 hours of
real unattended collection and monitoring evidence. The
[launch checklist](launch-checklist.md) remains authoritative. Local smoke tests
cannot substitute for these gates.
