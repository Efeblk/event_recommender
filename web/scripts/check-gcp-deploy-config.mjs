import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workflow = (await readFile(
  resolve(import.meta.dirname, '../../.github/workflows/gcp-staging.yml'),
  'utf8',
)).replaceAll('\r\n', '\n');

const collectorWorkflow = (await readFile(
  resolve(import.meta.dirname, '../../.github/workflows/gcp-collector.yml'),
  'utf8',
)).replaceAll('\r\n', '\n');

assert.match(workflow, /^\s{2}workflow_dispatch:/m);
assert.match(workflow, /input_interpreter:[\s\S]*?default: span-v2[\s\S]*?- rules\n\s*- jev-v1\n\s*- span-v2/);
assert.doesNotMatch(workflow, /^\s{2}(push|pull_request|schedule):/m);
assert.match(workflow, /^permissions:\n\s{2}contents: read$/m);
assert.match(workflow, /^\s{2}prepare:\n/m);
assert.match(workflow, /^\s{2}deploy:\n/m);

const prepare = workflow.slice(
  workflow.indexOf('  prepare:'),
  workflow.indexOf('  deploy:'),
);
const deploy = workflow.slice(workflow.indexOf('  deploy:'));

assert.doesNotMatch(prepare, /environment: gcp-staging|id-token: write|secrets\.|vars\./);
assert.match(prepare, /ref: \$\{\{ inputs\.expected_sha \}\}/);
assert.match(prepare, /test "\$EXPECTED_SHA" = "\$GITHUB_SHA"/);
assert.match(prepare, /deploy-gates\.mjs checks/);
assert.match(prepare, /\['gcp','terraform'\]/);
assert.match(prepare, /latest\?\.status!=='completed'/);
assert.match(prepare, /latest\?\.conclusion!=='success'/);
for (const command of [
  'npm test',
  'npm run typecheck',
  'npm run lint',
  'npm test --prefix ../collector',
  'npm run test:deploy-config',
  'npm run test:deploy:gcp',
  'check-release-cases.mjs',
  'evaluate-jev.ts',
  'npm run build:node',
  'npm run test:smoke:node',
]) assert.match(prepare, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(prepare, /docker build --pull --platform linux\/amd64/);
assert.match(prepare, /docker build[\s\S]+smoke-container\.mjs "\$LOCAL_IMAGE"[\s\S]+docker save/);
assert.match(prepare, /docker save .*gzip -n/);
assert.match(prepare, /sourceTree/);
assert.match(prepare, /lockfiles:/);
assert.match(prepare, /image\.sha256/);
assert.match(prepare, /manifest\.sha256/);
assert.match(prepare, /\(cd gcp-candidate && sha256sum image\.tar\.gz > image\.sha256 && sha256sum image\.sha256 provenance\.json > manifest\.sha256\)/);
assert.doesNotMatch(prepare, /sha256sum gcp-candidate\//);
assert.match(prepare, /Download candidate for round-trip verification/);

assert.match(deploy, /needs: prepare/);
assert.match(deploy, /environment: gcp-staging/);
assert.match(deploy, /id-token: write/);
assert.match(
  deploy,
  /uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ inputs\.expected_sha \}\}\n\s+persist-credentials: false/,
);
assert.match(deploy, /sha256sum --check manifest\.sha256/);
assert.match(deploy, /gunzip --stdout image\.tar\.gz \| docker load/);
assert.match(deploy, /Refuse snapshot deployment over PostgreSQL runtime/);
assert.match(deploy, /node web\/scripts\/guard-gcp-snapshot-deploy\.mjs/);
assert.match(deploy, /status\?\.traffic/);
assert.match(deploy, /gcloud run revisions describe/);
assert.ok(deploy.indexOf('actions/checkout@v4') < deploy.indexOf('guard-gcp-snapshot-deploy.mjs'));
assert.ok(deploy.indexOf('guard-gcp-snapshot-deploy.mjs') < deploy.indexOf('docker push "$REMOTE_TAG"'));
assert.doesNotMatch(deploy, /docker build/);
assert.match(deploy, /@sha256:\[0-9a-f\]\{64\}/);
assert.match(deploy, /--no-allow-unauthenticated/);
assert.match(deploy, /--no-traffic --quiet/);
const revisionVerification = deploy.indexOf('name: Resolve and verify deployed revision');
const revisionPromotion = deploy.indexOf('name: Promote verified revision and preserve tags');
const authenticatedHealth = deploy.indexOf('name: Verify authenticated staging health');
assert.ok(revisionVerification > deploy.indexOf('name: Deploy private staging revision'));
assert.ok(revisionPromotion > revisionVerification && authenticatedHealth > revisionPromotion);
const verificationBlock = deploy.slice(revisionVerification, revisionPromotion);
assert.match(verificationBlock, /latestCreatedRevisionName/);
assert.match(verificationBlock, /condition\.type === 'Ready'\)\?\.status !== 'True'/);
assert.match(verificationBlock, /container\.image !== process\.env\.IMAGE_REF/);
assert.match(verificationBlock, /\['DEPLOYMENT_SHA',process\.env\.EXPECTED_SHA\]/);
assert.match(verificationBlock, /\['INPUT_INTERPRETER',process\.env\.INPUT_INTERPRETER\]/);
assert.match(verificationBlock, /\(values\.CATALOG_BACKEND \?\? 'snapshots'\) !== 'snapshots'/);
const promotionBlock = deploy.slice(revisionPromotion, authenticatedHealth);
assert.match(promotionBlock, /--to-revisions "\$CANDIDATE_REVISION=100"/);
assert.match(promotionBlock, /--update-tags "\$TAG_CSV"/);
assert.match(promotionBlock, /JSON\.stringify\(afterTags\) !== JSON\.stringify\(beforeTags\)/);
assert.doesNotMatch(promotionBlock, /--to-latest/);
for (const flag of [
  '--min-instances 0',
  '--max-instances 1',
  '--concurrency 32',
  '--cpu 1',
  '--cpu-throttling',
  '--no-cpu-boost',
  '--memory 2Gi',
  '--timeout 300',
]) assert.match(deploy, new RegExp(flag));
assert.match(deploy, /BIPLAN_CLIENT_IP_MODE=shared/);
assert.match(deploy, /BIPLAN_PREVIEW_TESTING=false/);
assert.match(deploy, /AI_DAILY_LIMIT=100/);
assert.match(deploy, /VOYAGE_DIMENSIONS=1024/);
assert.match(deploy, /INPUT_INTERPRETER=\$INPUT_INTERPRETER/);
assert.match(deploy, /\[\[ "\$INPUT_INTERPRETER" == 'rules' \|\| "\$INPUT_INTERPRETER" == 'jev-v1' \|\| "\$INPUT_INTERPRETER" == 'span-v2' \]\]/);
for (const name of [
  'GCP_SYNC_TOKEN_SECRET_VERSION',
  'GCP_TYPESAFE_API_KEY_SECRET_VERSION',
  'GCP_VOYAGE_API_KEY_SECRET_VERSION',
]) {
  assert.match(deploy, new RegExp(`\\b${name}\\b`));
  assert.match(deploy, new RegExp(`\\$${name}`));
}
assert.doesNotMatch(deploy, /:latest/);
assert.doesNotMatch(workflow, /credentials_json|service_account_key|--allow-unauthenticated/);
assert.match(deploy, /token_format: id_token/);
assert.match(deploy, /id_token_audience: \$\{\{ steps\.service\.outputs\.url \}\}/);
assert.doesNotMatch(deploy, /gcloud auth print-identity-token/);
assert.match(deploy, /h\.status!=='ok'/);

// Cloud Scheduler dispatches collection; the only GitHub cron is the hourly backup.
assert.match(collectorWorkflow, /^\s{2}schedule:\n\s{4}- cron: '47 \* \* \* \*'$/m);
assert.doesNotMatch(collectorWorkflow, /cron: '17 /);
assert.match(collectorWorkflow, /^\s{2}workflow_dispatch:\n\s{4}inputs:\n\s{6}mode:/m);
assert.match(
  collectorWorkflow,
  /^\s{2}schedule_gate:\n\s{4}if: github\.event_name == 'workflow_dispatch' && inputs\.mode != 'index'$/m,
);
// The hourly monitor checks readiness and catalog age with the collector identity.
assert.match(collectorWorkflow, /^\s{2}monitor:\r?\n[\s\S]*?if: github\.event\.schedule == '47 \* \* \* \*'/m);
assert.match(collectorWorkflow, /\/api\/ready/);
assert.match(collectorWorkflow, /MAX_AGE_HOURS: '14'/);
// The hourly schedule runs only the indexing job; it never collects.
assert.match(
  collectorWorkflow,
  /^\s{2}index_only:\n[\s\S]*?\n\s{4}if: \(github\.event\.schedule == '47 \* \* \* \*' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.mode == 'index'\)\) && vars\.GCP_STAGING_INDEXING_ENABLED == 'true'$/m,
);
const collectorGate = collectorWorkflow.slice(
  collectorWorkflow.indexOf('  schedule_gate:'),
  collectorWorkflow.indexOf('  collect:'),
);
const collectorJob = collectorWorkflow.slice(collectorWorkflow.indexOf('  collect:'));
assert.match(collectorGate, /GCP_STAGING_COLLECTION_UNTIL/);
assert.match(collectorGate, /node collector\/schedule-gate\.mjs/);
assert.doesNotMatch(collectorGate, /environment:|id-token: write|secrets\./);
assert.match(collectorJob, /needs: schedule_gate/);
assert.match(collectorJob, /if: needs\.schedule_gate\.outputs\.run == 'true'/);
assert.match(collectorWorkflow, /^\s{4}environment: gcp-staging-collector$/m);
assert.doesNotMatch(collectorWorkflow, /^\s{4}environment: gcp-staging$/m);
assert.match(collectorJob, /id-token: write/);
assert.match(collectorWorkflow, /ref: \$\{\{ github\.sha \}\}/);
assert.match(collectorWorkflow, /--max-details 2000 --max-http 6000 --max-minutes 40 --discovery-pages 20/);
assert.match(collectorWorkflow, /uses: actions\/cache\/restore@v4/);
assert.match(collectorWorkflow, /uses: actions\/cache\/save@v4/);
assert.match(collectorWorkflow, /path: collector\/state\/coverage\.json/);
assert.match(collectorWorkflow, /restore-keys: gcp-staging-collector-coverage-/);
assert.match(collectorWorkflow, /cancel-in-progress: false/);
assert.doesNotMatch(collectorWorkflow, /INDEX_EMBEDDINGS|embeddings:index|TYPESAFE|VOYAGE/);
assert.match(collectorWorkflow, /if: vars\.GCP_STAGING_INDEXING_ENABLED == 'true'/);
for (const name of ['FROM', 'UNTIL', 'MAX_CALLS']) assert.match(collectorWorkflow, new RegExp(`GCP_STAGING_INDEXING_${name}`));
assert.match(collectorWorkflow, /node --experimental-strip-types web\/scripts\/index-collected-embeddings\.mjs --live --report/);
assert.match(collectorWorkflow, /id: index/);
assert.match(collectorWorkflow, /status=\$\?/);
assert.match(collectorWorkflow, /2\)[\s\S]*outcome=bounded-stop[\s\S]*::warning title=Embedding indexing remains pending/);
assert.match(collectorWorkflow, /\*\)[\s\S]*exit "\$status"/);
assert.doesNotMatch(collectorWorkflow, /continue-on-error/);
assert.match(collectorWorkflow, /if: always\(\) && steps\.publish\.outcome == 'success'/);
assert.match(collectorWorkflow, /collection-embedding-index\.jsonl\*/);
assert.doesNotMatch(collectorWorkflow, /Prepare replacement PostgreSQL|GCP_STAGING_PIPELINE_ENABLED|BIPLAN_PIPELINE_PG/);
const artifactPaths = collectorWorkflow.slice(collectorWorkflow.indexOf('name: Save normalized data'));
assert.doesNotMatch(artifactPaths, /collector\/state\/raw(?:\/|\s)|collector\/output\/(?:html|raw)(?:\/|\s)/);
const publicPaths = artifactPaths.split('path: |')[1]?.split('if-no-files-found:')[0]
  .split('\n').map(line => line.trim()).filter(Boolean);
assert.ok(publicPaths?.length, 'Collection artifact paths must be explicit.');
for (const path of publicPaths) {
  assert.ok(/^collector\/(?:output|state)\/[a-z-]+\.json$/.test(path) ||
    path === 'web/work/collection-embedding-index.jsonl*', 'Only explicit JSON reports can be public artifacts.');
}

console.log('GCP staging deployment configuration is structurally valid.');
