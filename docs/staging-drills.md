# Staging recovery and load drills

These drills are release evidence for staging. They do not deploy a Worker, alter production, purchase a plan, or prove Cloudflare CPU capacity. Run them only after staging `/api/health` reports the exact candidate revision and `/api/ready` is healthy.

The helper is dry-run by default:

```powershell
cd web
node scripts/staging-drill.mjs `
  --origin https://biplan-staging.example.workers.dev `
  --expected-revision 0123456789abcdef0123456789abcdef01234567 `
  --source-d1 biplan-staging `
  --recovery-d1 biplan-staging-recovery-20260926 `
  --r2-bucket biplan-staging-state `
  --config dist/server/wrangler.staging.json
```

Review the printed plan. The source D1 and R2 names must contain `staging`. The recovery database must be a different, previously unused name containing `drill`, `recovery`, or `restore`. The tool refuses an existing recovery database and never deletes it. During execution it also reads the compiled staging config and requires its deployment environment, revision, `DB` name, and `COLLECTION_STATE` bucket to match the command exactly.

The default artifact directory is under ignored `web/work/`. Keep recovery artifacts there or choose another private, ignored location: the SQL export includes all database rows and may contain user-derived rate-limit keys.

## Execute the recovery drill

Set the protected staging sync token in the process environment. Do not put it in a command argument, file, log, or report.

```powershell
$env:STAGING_SYNC_TOKEN = '<protected staging value>'
node scripts/staging-drill.mjs `
  --execute `
  --origin https://biplan-staging.example.workers.dev `
  --expected-revision 0123456789abcdef0123456789abcdef01234567 `
  --source-d1 biplan-staging `
  --recovery-d1 biplan-staging-recovery-20260926 `
  --r2-bucket biplan-staging-state `
  --config dist/server/wrangler.staging.json `
  --artifact-dir work/staging-drill-20260926
Remove-Item Env:STAGING_SYNC_TOKEN
```

The tool performs these guarded steps:

1. Read the compiled configuration and require the staging environment, exact revision, D1 binding, and R2 binding supplied on the command line; then read `/api/health` and require the same environment and revision from the running Worker.
2. Read `/api/ready` and require a ready catalog/checkpoint.
3. List D1 databases and stop unless the source exists and the recovery name does not.
4. Export the remote staging D1 to `source.sql`, create the new recovery D1, and import the SQL there.
5. Read bounded, sorted pages for `events`, `embeddings`, `voyage_embeddings`, `metadata`, and `request_limits`; compare both row counts and SHA-256 content digests between source and recovery. The source is digested before and after export, and the drill stops without claiming snapshot integrity if live staging changed during that window.
6. Read the actual private R2 checkpoint through authenticated `GET /api/admin/collection`, compare its saved time and event count with `/api/ready`, and save the bounded JSON locally.
7. Preserve `source.sql`, `checkpoint.json`, and `result.json`, including SHA-256 hashes. No secret value is written.

If any step fails, preserve the artifact directory and the disposable database for investigation. Delete the recovery database manually only after reviewing its exact name in the Cloudflare dashboard or `wrangler d1 list`; cleanup is intentionally outside the tool.

[Cloudflare's D1 import/export guide](https://developers.cloudflare.com/d1/best-practices/import-export-data/) documents `wrangler d1 export <name> --remote --output=<file>` for full exports and `wrangler d1 execute <name> --remote --file=<file>` for imports. The import limit is 5 GiB. The protected Worker endpoint is preferred for checkpoint recovery because it exercises the application's D1 pointer and private R2 readback together. Direct R2 inspection, when needed, follows the [R2 Wrangler command](https://developers.cloudflare.com/r2/reference/wrangler-commands/) `wrangler r2 object get <bucket>/<key> --remote --file <path>` after verifying the key from protected readiness evidence.

## Bounded staging load

Add `--load` only with `--execute`. The default makes seven genuine recommendation requests in concurrency batches 1, 2, and 4, with 25 seconds between batches. `--max-load-requests` may reduce this or raise it to at most 12. Requests use natural controlled concert-and-budget prompts, have a 45-second deadline, make no automatic retries, and keep the application's ordinary rate limits and configured AI path enabled.

```powershell
node scripts/staging-drill.mjs `
  --execute --load --max-load-requests 7 `
  --origin https://biplan-staging.example.workers.dev `
  --expected-revision 0123456789abcdef0123456789abcdef01234567 `
  --source-d1 biplan-staging `
  --recovery-d1 biplan-staging-recovery-load-20260926 `
  --r2-bucket biplan-staging-state `
  --config dist/server/wrangler.staging.json `
  --artifact-dir work/staging-load-20260926
```

The private result artifact retains every request input, parsed application response, HTTP status, duration, validation error, and observed recommendation mode. The command fails after preserving evidence if any response is non-200, invalid JSON, fallback/degraded mode, empty, over budget, outside the concert category, missing a source URL, or duplicated within the response. The recorded provider-transport count is only an upper bound because the public response does not expose exact provider calls. Review Cloudflare observability for the exact Worker revision. Local or client wall time is not Worker CPU time, isolate memory, or proof that the Free plan can sustain production traffic. Record provider usage separately and stop if the approved live-call budget would be exceeded.

## Release evidence

Keep the command line with secrets redacted, exact revision, staging resource names, Wrangler version, artifact hashes, D1 count/content-digest comparison, checkpoint metadata, request statuses, and Cloudflare CPU/error telemetry. The SQL export can contain user-derived rate-limit keys and must remain an access-controlled recovery artifact; do not paste it into chat or attach it to a public issue. This drill complements rather than replaces the required 48-hour unattended collection observation, source refresh evidence, rollback verification, and protected environment review.
