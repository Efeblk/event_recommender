# Release readiness — 24 September 2026

This is a local release audit, not a deployment or approval to purchase services.
The user selected free-first development and staging. The generated deployment
configuration now defaults to `WORKERS_PLAN=free`; the paid CPU allowance requires
an explicit `WORKERS_PLAN=paid`. Neither setting changes the account subscription.

## Local evidence

- All 222 web unit/regression tests, 15 deployment/rollback tests, typecheck and
  lint pass. The collector's 32 tests also pass after its lockfile update.
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
- Real browser readback confirmed one “Suç Ve Ceza” card at Taksim İstiklal Sahne,
  with the Bubilet 200 TRY and Biletix 252 TRY offers together. The reviewed alias
  also merges the three other matching dates without combining separate sessions.
  The resulting catalog has 2,390 canonical eligible sessions; all 1,228 required
  embedding documents remain cached, with zero pending and no reindexing cost.
- Real local catalog pages were also rendered at 1440px and 375px with no uncaught
  browser errors or horizontal overflow. T3Code's preview automation host was
  unavailable; headless Chromium was used without controlling the desktop.
- Full-catalog Node profiling reduced median CPU by 60–67% through cached timezone
  formatters and avoiding unused filter work. See [deployment measurements](deployment.md).
  This is not Cloudflare CPU or memory telemetry and does not establish Free-plan
  capacity. No catalog truncation or embedding-dimension reduction was introduced.
- An isolated compiled workerd run exercised the keyless fallback against the full
  2,909-row catalog (2,749 eligible source rows), with fresh temporary D1/R2 state.
  All concurrency 1/4/8 requests returned HTTP 200 and two cards. Median batch wall
  times were 399/1,495/2,994 ms. These are local timings, not Cloudflare CPU or isolate
  memory measurements; this check did not exercise live semantic/provider latency.
- Rollback verification now checks that the requested Worker version receives all
  traffic before accepting its environment health response. A healthy old version
  is no longer sufficient evidence of a successful rollback.

## Live release regression

The [20-request report](../web/evals/reports/2026-09-24-release-live.json)
records compiled runtime `fa7d62b`, with no runtime edits during the run. Its dirty
flag reflects pending diagnostic/CI files; subsequent commits before completion
only added diagnostic tooling and evidence. Requests were spaced by 25 seconds,
with no automatic retries. All returned HTTP 200 in 34–2,138 ms.

The [mechanical grade](../web/evals/reports/2026-09-24-release-grade.json)
found zero hard-constraint failures across all eight returned cards. It deliberately
reports `needs_review`: empty results and subjective relevance require catalog review.

| Outcome | Cases | Review |
| --- | ---: | --- |
| Results, Jev mode | 4 | Waiving alcohol-free restores concerts; warm/cozy mood finds source-described fits; Kadıköy stand-up respects session/budget; quoted instructions do not change theatre to concert. |
| Explained empty | 15 | Catalog audit confirms no hard-filter matches or no required source evidence. Unknown prices do not count as free, and unknown alcohol/accessibility policies do not pass. |
| Unsupported location | 1 | İzmir is explicitly rejected, with no Istanbul cards. |

The empty cases are not evidence that no suitable event exists in Istanbul. They
reflect this collected catalog and its incomplete descriptions. In particular,
mandatory comedy/classical/jazz evidence removes otherwise plausible broad-category
matches. Four cases with clear supported catalog choices all return two results.
Manual review found no unsuitable returned card. The Corner Kadıköy and
Operadaki Hayalet cards retain multiple providers within one session. Kuyucaklı
Yusuf Muazzez is a qualified match because its description is sparse, although
its title/category establish theatre and its date/price satisfy the request.

For the soft mood request, Çalıkuşu's description explicitly describes warmth,
hope and a sincere atmosphere; Çağan Şengül's describes emotional songs and an
intimate atmosphere. These are plausible recommendations, not guarantees about
indoor weather protection or how the user will feel. The captured response was
also replayed through the 375px browser UI: both cards rendered, with no uncaught
errors or horizontal overflow and no additional provider call.

The default display now returns up to two supported suggestions, with alternatives
available. This avoids filling the first response with lower-ranked options;
it does not calibrate Jev probabilities or prove general recommendation accuracy.
The earlier mood diagnostic remains unchanged and shows the additional weaker
third option that motivated the smaller display count.

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
