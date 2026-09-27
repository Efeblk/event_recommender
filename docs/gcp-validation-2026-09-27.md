# GCP migration validation — September 27, 2026

Local migration checks ran on Windows with Node 22.23.3, on the dirty
`t3code/gcp-migration` worktree based on `6437f7c`. These results are local evidence,
not a deployed GCP revision. Google sign-in and resource provisioning were
explicitly deferred. No GCP resources were created and no new AI calls were made.

| Check | Result |
| --- | --- |
| Web unit tests, including GCP storage/SDK/IP/bootstrap cases | 278 passed |
| Collector tests, including separate Cloud Run and sync authorization | 43 passed |
| Web typecheck and lint | Passed |
| Existing deployment configuration suite | 31 passed |
| GCP workflow structure and all-workflow actionlint | Passed |
| Terraform format, validate, four mocked plans | Passed without credentials |
| Cloudflare build and isolated D1/R2/Voyage smoke | Passed |
| Node standalone build and compiled smoke | Passed after fixing runtime alias resolution |
| Frozen conversation cases | 20 passed, zero live calls |
| Historical Jev score replay | 12 whole-list cases correct, zero live calls; not current model evaluation |

The compiled Node smoke verifies the page, public configuration, admin auth,
missing GCP settings, selection of the Node storage implementation, and loading
the packaged Google SDKs without RPCs. Fake SDK/domain tests exercise publication
fencing, failed-source retention, complete-catalog retrieval, transactional rate
caps, exact vector profiles, corrupt objects and bootstrap bounds. The local
Docker daemon was unavailable; Linux image validation is a required CI gate.

The migration dry-run used 4,595 canonical records from preserved collector run
`36271239817` and 1,718 cached 1,024-dimension Voyage vectors from read-only local
D1. It grouped 1,696 source pages without omitting records. The input checkpoint
envelope was reconstructed from the collector's canonical readback, original
report and original `publication.savedAt`; it is **not** a byte-identical download
of the original R2 checkpoint. Original source times remain unchanged, including
stale records. A count of stored records is not a count of eligible events.

- Reconstructed checkpoint SHA-256: `6445304618957bd1599f02947d7973ea462fb568ce5930a5fac89916beb81867`.
- Exact-profile vector export SHA-256: `44e32c3eef837a5c193eaabef2ed5a06eb318eb35f5c2a06454fcbc39f0d552b`.
- Ignored inputs and provenance: `web/work/gcp-bootstrap/`.

A full rehearsal using injected memory transports imported, published and
restored all 4,595 records exactly. At the fixed reference time
`2026-09-26T22:55:00Z`, its 3,445 eligible merged candidates matched the existing
merge/eligibility logic. Price/category/date samples also matched (1,267 at a
500 TL maximum, 1,790 theatre events, 313 on October 1–3). Every cached vector
was compared exactly; an incompatible profile returned none. Eight concurrent
requests against a cap of two admitted exactly two. This is data/logic evidence,
not a GCP transport or capacity test. Ignored rehearsal report SHA-256:
`9deef8e222317f8d44a9fecb96cf30a2fdd884be7d4f18e98d373cbc003de076`.

Testing exposed and fixed two Node build defects: resolving a local preview
configuration from a credential-free build directory, and Vinext's TypeScript
path mapping overriding the intended runtime alias. Compiled smoke now requires
the Node-only legacy-sync response so that selecting D1 cannot pass silently.
Review also found and fixed an older-report/newer-source publication race and a
bootstrap empty-target check outside its lease. Original local failed-build logs
remain in `web/work/`; they have not been replaced with successful results.

Outstanding: authenticated GCP SDK/IAM integration, live catalog bootstrap and
readiness, Linux container CI on the latest commit, trusted-IP spoof checks,
Cloud Run capacity/latency, safe snapshot/counter cleanup, recovery drills,
independent monitoring and 48 hours of unattended collection. Preparing this
migration does not satisfy public-production release gates.
