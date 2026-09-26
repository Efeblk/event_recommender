import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workflow = await readFile(
  resolve(import.meta.dirname, '../../.github/workflows/gcp-staging.yml'),
  'utf8',
);

assert.match(workflow, /^\s{2}workflow_dispatch:/m);
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
assert.match(deploy, /sha256sum --check manifest\.sha256/);
assert.match(deploy, /gunzip --stdout image\.tar\.gz \| docker load/);
assert.doesNotMatch(deploy, /docker build/);
assert.match(deploy, /@sha256:\[0-9a-f\]\{64\}/);
assert.match(deploy, /--no-allow-unauthenticated/);
for (const flag of [
  '--min-instances 0',
  '--max-instances 1',
  '--concurrency 32',
  '--cpu 1',
  '--cpu-throttling',
  '--no-cpu-boost',
  '--memory 1Gi',
  '--timeout 300',
]) assert.match(deploy, new RegExp(flag));
assert.match(deploy, /BIPLAN_CLIENT_IP_MODE=shared/);
assert.match(deploy, /AI_DAILY_LIMIT=100/);
assert.match(deploy, /VOYAGE_DIMENSIONS=1024/);
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

console.log('GCP staging deployment configuration is structurally valid.');
