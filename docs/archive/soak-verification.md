# 48-hour collection and readiness evidence

The release gate requires overlapping collection and readiness evidence for at least 48 elapsed hours. Local runs, fixture tests, and a single successful workflow do not satisfy it.

Collection runs produce schema-version 2 `collection-run` evidence. A qualifying record contains the deployed Worker environment and 40-character revision read from `/api/health`, a unique GitHub run ID and attempt, `githubEventName: "schedule"`, successful canonical checkpoint readback, positive integer refreshed-page counts for `biletinial`, `bubilet`, and `biletix`, and `artifactOnly: false`. Generate the publication receipt and evidence with:

```sh
npm run publish --prefix collector -- --checkpoint --snapshot state/events.json --receipt output/publication.json
npm run soak:report --prefix collector -- --publication output/publication.json
```

Artifact-only collection remains explicitly nonqualifying because it has no publication receipt.

Each monitor run writes this non-secret record:

```json
{
  "schemaVersion": 1,
  "kind": "readiness-monitor",
  "recordedAt": "2026-09-26T12:00:00.000Z",
  "environment": "staging",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "ready": true,
  "reasons": [],
  "provenance": { "githubRunId": "123", "githubRunAttempt": "1", "githubEventName": "schedule" }
}
```

The monitor reads environment and revision from `/api/health`, checks `/api/ready`, and persists sanitized failure reasons before exiting unsuccessfully:

```sh
BIPLAN_URL=https://example.workers.dev npm run monitor --prefix collector -- --environment staging --output output/readiness-monitor.json
```

After downloading the immutable artifacts, verify them with repeated file options:

```sh
npm run soak:verify --prefix collector -- \
  --environment staging \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --collection artifacts/run-1/soak-evidence.json \
  --collection artifacts/run-2/soak-evidence.json \
  --monitor artifacts/hour-1/readiness-monitor.json \
  --monitor artifacts/hour-2/readiness-monitor.json
```

The verifier requires a healthy overlap of at least 48 hours, unique GitHub run provenance in each stream, no collection gap over 15 hours, and no monitor gap over 90 minutes. Every supplied record must have recorded `githubEventName: "schedule"`; manually dispatched bootstrap or diagnostic records remain useful artifacts but do not qualify as unattended evidence. Select only scheduled collection and monitor artifacts when invoking the verifier. Missing event provenance and older schemas remain invalid and are never rewritten. These tolerances allow three hours of delay around the 12-hour collection schedule and 30 minutes around hourly readiness checks. It reports exact first/last timestamps, spans, maximum gaps, and failure reasons. It never fills missing intervals or converts local smoke timestamps into operational evidence.

Scheduled collection and readiness monitoring share the repository variable `SCHEDULED_COLLECTION_ENVIRONMENTS`. It must be a unique JSON array containing only `"staging"` and `"production"`; it defaults to `["production"]`. Set it to `["staging"]` during staging soak observation so both schedules target the same active environment without code changes. Manual dispatch still selects one environment explicitly. Both workflows validate the matrix before any environment-scoped job starts and check out the exact trigger SHA; collection evidence records that checkout separately from the deployed Worker revision. Collection jobs targeting the same environment share one non-cancelling concurrency group, so scheduled and manual publication cannot overlap.

Voyage indexing remains opt-in through the protected environment variable `INDEX_EMBEDDINGS=true`. An enabled collection run sends at most 20 indexing batches, waits 60 seconds between successful pending batches, and performs no automatic retry. The 60-minute job timeout accommodates the observed collection duration plus at most 19 pacing intervals. The indexing driver exits with status 2 when coverage remains incomplete at the batch ceiling; the workflow preserves that failure and does not record the run as successfully completed soak evidence.
