import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const envValue = (revision, name) => revision?.spec?.containers?.[0]?.env?.find(item => item.name === name)?.value;

export function assertSnapshotDeployCompatible(service, revisions) {
  const templateBackend = envValue(service?.spec?.template, 'CATALOG_BACKEND');
  if (templateBackend === 'postgres') throw new Error('Snapshot deployment refuses to replace a PostgreSQL service template');
  const traffic = (service?.status?.traffic ?? []).filter(item => Number(item.percent ?? 0) > 0);
  const byName = new Map(revisions.map(revision => [revision?.metadata?.name, revision]));
  for (const target of traffic) {
    if (!target.revisionName) throw new Error('Snapshot deployment cannot resolve a live traffic revision');
    const revision = byName.get(target.revisionName);
    if (!revision) throw new Error(`Missing live traffic revision readback: ${target.revisionName}`);
    if (envValue(revision, 'CATALOG_BACKEND') === 'postgres')
      throw new Error(`Snapshot deployment refuses to replace PostgreSQL live revision: ${target.revisionName}`);
  }
  return { templateBackend: templateBackend ?? 'snapshots', checkedTrafficRevisions: traffic.map(item => item.revisionName) };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length < 4) throw new Error('Usage: guard-gcp-snapshot-deploy.mjs SERVICE.json REVISION.json [...]');
  const [service, ...revisions] = await Promise.all(process.argv.slice(2).map(async path => JSON.parse(await readFile(path, 'utf8'))));
  console.log(JSON.stringify(assertSnapshotDeployCompatible(service, revisions)));
}
