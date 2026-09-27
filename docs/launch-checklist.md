# Public beta launch sequence

GCP is the selected target. No GCP deployment or public launch has happened as a
result of the migration code. The historical Cloudflare evidence is retained,
but does not qualify a different runtime or storage backend.

1. **Exact-revision verification:** pass web/collector tests, typecheck, lint,
   deployment validation, Node standalone startup and Linux container checks on
   the candidate revision. Keep the Cloudflare build/smoke green for recovery.
2. **Dedicated account resources:** after Google sign-in, verify billing and
   review the Terraform plan in [infra/gcp](../infra/gcp/README.md). Separate
   staging and production projects, private buckets, service identities and
   secrets. Configure protected deployment environments and restricted GitHub WIF.
3. **Private staging:** approve the concrete candidate image and resource plan,
   deploy through the manual GCP workflow, verify revision/digest and authenticated
   health, bootstrap the preserved catalog and cached Voyage vectors, then require
   fresh checkpoint readback and readiness. Empty initial health is not readiness.
4. **Unattended observation:** deliberately enable collection and monitoring only
   after manual staging succeeds. Collect at least 48 hours of scheduled evidence
   across all three providers. Explain missed intervals and failed sources.
   Verify an independent alert path that can monitor private GCP staging; neither
   a manually dispatched run nor the old Cloudflare monitor qualifies.
5. **Recommendation quality:** provision Jev and Voyage keys securely. Evaluate
   live Turkish and English conversations with a bounded, authorized call budget.
   Inspect every card against provider evidence, including follow-ups, negation,
   accessibility, policy and group budgets. Review empty results for missed
   eligible events. Check complete-catalog retrieval and exact cached-vector
   coverage. Keep original failures and distinguish offline replay from live calls.
6. **Recovery, abuse and capacity:** exercise restoration into isolated GCP data
   resources, immutable-image rollback, missing-object failure and provider outage
   fallback. Measure Cloud Run latency, memory, scaling and service quotas with the
   real catalog. Qualify the trusted client-IP header under spoof attempts before
   enabling per-IP public limits. Test concurrent Firestore caps and the global AI
   budget. Establish safe cleanup for unreferenced snapshots and expired counters;
   do not expire referenced objects merely because they are old.
7. **Limited beta:** obtain publication authorization, deploy the exact tested
   image digest into separate production resources, run fresh collection and
   readiness checks, then invite the first 20?50 testers. Verify privacy/data-use
   and source/price notices. Donation and ad integrations remain placeholders.

Follow the free-first preference. The proposed demo scales to zero with maximum
one instance; this is a cost control, not a guarantee of zero spend. Review region,
billing, storage retention and provider budgets after sign-in. Budget alerts are
not spending caps. See [GCP deployment](gcp-deployment.md) for the current plan.

## Evidence

- `web/scripts/smoke.mjs`: real compiled Worker, isolated D1/R2; import/auth/restart behavior, canonical checkpoints, stale/missing checkpoint detection.
- `collector/tests/reliability.test.mjs`: simulated HTTP restore, partial-import failure, checkpoint receipt/readback and readiness failures.
- `collector/output/soak-evidence.json`: generated evidence for one real run; never a substitute for elapsed observation.
- `web/scripts/evaluate-jev.ts`: dry run by default; `--live` explicitly sends up to 12 evaluation calls and records returned token usage/latency.
- GitHub deployment artifacts: exact SHA, build hashes, non-secret configuration and provenance.
- [September 27 readiness record](release-readiness-2026-09-27.md): deployed staging identity, confirmed CPU failure, local rate-limit checks and outstanding cloud gates. Historical observations do not replace rechecking the candidate revision.

Do not mark cloud deployment, the 48-hour observation, live AI quality, restore drills or tester acceptance complete until each has its own recorded evidence.
