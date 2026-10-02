import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSnapshotDeployCompatible } from '../scripts/guard-gcp-snapshot-deploy.mjs';

const revision = (name, backend) => ({ metadata:{ name }, spec:{ containers:[{ env:backend ? [{ name:'CATALOG_BACKEND',value:backend }] : [] }] } });
const service = backend => ({ spec:{ template:{ spec:revision('template',backend).spec } }, status:{ traffic:[{ revisionName:'live',percent:100 }] } });

await test('allows a snapshot template only when every live traffic revision is also snapshot-backed', () => {
  assert.deepEqual(assertSnapshotDeployCompatible(service(undefined),[revision('live',undefined)]),
    { templateBackend:'snapshots',checkedTrafficRevisions:['live'] });
});
await test('rejects a PostgreSQL latest template even while old snapshot traffic remains live', () => {
  assert.throws(()=>assertSnapshotDeployCompatible(service('postgres'),[revision('live',undefined)]),/PostgreSQL service template/);
});
await test('rejects PostgreSQL live traffic even when the latest template differs', () => {
  assert.throws(()=>assertSnapshotDeployCompatible(service(undefined),[revision('live','postgres')]),/PostgreSQL live revision/);
});
await test('fails closed when a live traffic revision was not read back', () => {
  assert.throws(()=>assertSnapshotDeployCompatible(service(undefined),[]),/Missing live traffic revision/);
});
await test('protects the rebuilt pipeline template and live revision from snapshot replacement', () => {
  assert.throws(()=>assertSnapshotDeployCompatible(service('pipeline'),[revision('live',undefined)]),/PostgreSQL service template/);
  assert.throws(()=>assertSnapshotDeployCompatible(service(undefined),[revision('live','pipeline')]),/PostgreSQL live revision/);
});
