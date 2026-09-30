import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresJobManifest } from '../scripts/render-postgres-job.mjs';
const base = { mode:'prepare',projectNumber:'123456789012',image:`us-central1-docker.pkg.dev/biplan-staging-efeblk/biplan-staging/biplan-preparation@sha256:${'a'.repeat(64)}`,
  revision:'b'.repeat(40),secretVersion:'2',batchId:'verified-batch' };

await test('Job binds immutable image, explicit staging identity, numeric secret and no automatic retries',()=>{
  for (const mode of ['prepare','publish']) {
    const job = postgresJobManifest({ ...base,mode }), task = job.spec.template.spec.template.spec;
    assert.equal(job.metadata.namespace,base.projectNumber); assert.equal(job.metadata.name,`biplan-staging-catalog-${mode}`);
    assert.equal(job.spec.template.spec.taskCount,1); assert.equal(job.spec.template.spec.parallelism,1);
    assert.equal(task.maxRetries,0); assert.equal(task.timeoutSeconds,'180');
    assert.equal(job.spec.template.metadata.annotations['run.googleapis.com/secrets'],
      'biplan-staging-db-preparation-password:projects/123456789012/secrets/biplan-staging-db-preparation-password');
    assert.equal(task.serviceAccountName,'biplan-staging-preparation@biplan-staging-efeblk.iam.gserviceaccount.com');
    const container=task.containers[0]; assert.deepEqual(container.args,[mode,base.batchId]);
    assert.equal(container.env.find(e=>e.name==='BIPLAN_PG_PASSWORD').valueFrom.secretKeyRef.key,'2');
    assert.ok(container.env.find(e=>e.name==='BIPLAN_PG_HOST').value.startsWith('/cloudsql/biplan-staging-efeblk:'));
    assert.equal(container.env.some(e=>/VOYAGE|TYPESAFE|SYNC_TOKEN|GOOGLE_APPLICATION_CREDENTIALS/.test(e.name)),false);
  }
});
await test('source Job pins object generation and hash and stays separate from publication',()=>{
  const sha='c'.repeat(64), input={...base,mode:'source',image:base.image.replace('biplan-preparation@','biplan-source-ingestion@'),
    bucket:'biplan-staging-efeblk-biplan-staging-data',artifact:{key:`staging/preparation/sources/${sha}.json`,generation:'42',sha256:sha}};
  const container=postgresJobManifest(input).spec.template.spec.template.spec.containers[0];
  assert.deepEqual(container.args,[base.batchId,input.artifact.key,'42',sha]);
  assert.equal(container.env.find(e=>e.name==='CATALOG_SOURCE_LIMIT').value,'100');
  assert.throws(()=>postgresJobManifest({...input,artifact:{...input.artifact,generation:'0'}}),/artifact/);
  assert.throws(()=>postgresJobManifest({...input,bucket:'unrelated-bucket'}),/artifact/);
});
await test('mutable images, foreign identity, raw secrets and cross-mode inputs fail closed',()=>{
  for (const input of [ {...base,image:base.image.replace(/@sha256:.+$/,':latest')}, {...base,secretVersion:'latest'},
    {...base,image:base.image.replace('biplan-staging-efeblk/','unrelated-project/')}, {...base,password:'never-log'},
    {...base,artifact:{}}, {...base,mode:'publish-public'} ]) assert.throws(()=>postgresJobManifest(input));
});
