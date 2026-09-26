# Free demo capacity evidence — 2026-09-27

> Follow-up: the user selected GCP after this evaluation. See [GCP deployment](gcp-deployment.md). Measurements below remain historical evidence, not validation of the new target.

This record captures the bounded staging evidence collected while evaluating whether the demo can remain on Cloudflare's Free profile. It does not replace the launch gates in [deployment.md](deployment.md) or [launch-checklist.md](launch-checklist.md). The machine-readable companion is [2026-09-27-free-capacity.json](../web/evals/reports/2026-09-27-free-capacity.json).

## Verified behavior

- The isolated `biplan-staging-capacity-probe` had no D1 binding, AI keys, or configured CPU override. Exactly two authenticated candidate-preparation requests ran against 16 fixed events without calling Jev or Voyage. The cold request with six 2,000-character history turns returned HTTP 200 with 16 candidates and used 51 ms CPU / 55 ms wall time; the minimal-history request returned HTTP 200 with 16 candidates and used 9 ms CPU / 10 ms wall time. Both outcomes were `ok` with no exceptions. The 51 ms execution shows observed elastic acceptance, not a guaranteed Free allowance or production capacity.
- The deployed main staging revision remains `4de58c1d9a0dd499efa373a6092d0ec06e2bd6fd`. Its public `GET /api/events` returned HTTP 503 and Cloudflare reported `exceededCpu` at 10 ms CPU. `GET /api/health` in the same bounded check returned HTTP 200. Later rate-limit work is therefore not live on staging.
- One read-only D1 JSON-vector query returned HTTP 200 with 1,718 results in 1,330.4451 ms of reported database duration. It read 5,282,487 rows and wrote zero. This likely consumed the configured Free daily read allowance, but no quota-exceeded response was captured, so quota exhaustion is not proven. Further D1 probes stopped.
- Collection run `36271239817` succeeded. It saved and read back the checkpoint at `2026-09-26T21:30:14.188Z`; the canonical checkpoint contained 4,595 records. The checkpoint is not a claim that all records were freshly collected: the run carried prior records, had one incomplete listing, and includes one expired legacy record with no source. This is one collection run, not the required 48-hour unattended soak.

## Release state

- PR #5 source revision `7c9d22755d563bf38b3544a227ad6b581f8a9f4f` passed all five core checks. The recorded merge commit begins `010a`; staging still serves revision `4de58c1d9a0dd499efa373a6092d0ec06e2bd6fd`.
- Prepared Free artifact run `36274065783` was independently verified: 95 compiled files, hidden files present, manifest SHA-256 `bf7f897f27de55cba15994c95daa03dd25795d664a16480049461adc06192243`, and the configured secret scan passed. The artifact remains pending protected deployment approval and was not published.
- UptimeRobot's activation endpoint returned HTTP 200 with a conditional response. Delivery, activation and an active monitor have not been verified.
- The user selected Free for the demo and subsequently requested an AWS/GCP comparison. No alternative-hosting decision, Google Cloud or AWS deployment, paid-plan selection, or billing change has been made.

Experimental full-projection and vector-SQL work remains undeployed. Its patch, draft and tested vector component were moved to ignored local reference files while the hosting comparison proceeds. The cloud capacity probes made no Jev or Voyage calls, so they added no provider usage beyond the previously recorded collection and embedding work.

After reviewing the evidence, the temporary capacity-probe Worker was deleted.
Its active version matched the tested version before deletion; the delete
returned HTTP 200 and one verification returned HTTP 404. Main staging, D1,
R2 and billing were unchanged. The cleanup receipt is preserved locally at
`web/work/free-capacity-probe/cleanup-evidence.json`.
