import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = 'biplan-staging-efeblk', region = 'us-central1';
const secret = 'biplan-staging-db-preparation-password';
const connection = `${project}:${region}:biplan-staging-catalog-pg17`;
const allowed = ['mode','projectNumber','image','revision','secretVersion','batchId','bucket','artifact'];
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,249}$/.test(value);

/** Offline rendering only. Cloud readback and the approved saved plan precede deployment. */
export function postgresJobManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k)))
    throw new Error('Invalid staging Job settings');
  const { mode, projectNumber, image, revision, secretVersion, batchId } = input;
  if (!['source','prepare','publish'].includes(mode) || !identifier(batchId) ||
      typeof projectNumber !== 'string' || !/^[1-9]\d{5,19}$/.test(projectNumber) ||
      typeof secretVersion !== 'string' || !/^[1-9]\d*$/.test(secretVersion) || !/^[a-f0-9]{40}$/.test(revision ?? ''))
    throw new Error('Invalid staging Job identity or version');
  const imageName = mode === 'source' ? 'biplan-source-ingestion' : 'biplan-preparation';
  if (typeof image !== 'string' || !image.startsWith(`${region}-docker.pkg.dev/${project}/biplan-staging/${imageName}@sha256:`) ||
      !/^[a-f0-9]{64}$/.test(image.split('@sha256:')[1] ?? '')) throw new Error('Staging Job requires the expected immutable image');
  const env = [
    ['BIPLAN_GCP_PROJECT',project], ['DEPLOYMENT_ENV','staging'], ['DEPLOYMENT_SHA',revision],
    ['BIPLAN_PG_HOST',`/cloudsql/${connection}`], ['BIPLAN_PG_DATABASE','biplan_catalog'], ['BIPLAN_PG_USER','biplan_preparer'],
    ['BIPLAN_PG_POOL_MAX','2'], ['BIPLAN_PG_STATEMENT_TIMEOUT_MS','30000'], ['CATALOG_PROCESS_DEADLINE_MS','90000'],
  ].map(([name,value]) => ({ name,value }));
  let args;
  if (mode === 'source') {
    const a = input.artifact;
    if (input.bucket !== `${project}-biplan-staging-data` || !a || Object.keys(a).some(k => !['key','generation','sha256'].includes(k)) ||
        !/^[a-f0-9]{64}$/.test(a.sha256 ?? '') || a.key !== `staging/preparation/sources/${a.sha256}.json` ||
        typeof a.generation !== 'string' || !/^[1-9]\d*$/.test(a.generation)) throw new Error('Invalid staging source artifact');
    args = [batchId,a.key,a.generation,a.sha256];
    env.push({ name:'GCP_STORAGE_BUCKET',value:input.bucket },{ name:'CATALOG_SOURCE_LIMIT',value:'100' });
  } else {
    if (input.bucket !== undefined || input.artifact !== undefined) throw new Error('Preparation Job cannot accept source upload settings');
    args = [mode,batchId];
    env.push({ name:'CATALOG_BATCH_MAX_JOBS',value:'100' },{ name:'CATALOG_BATCH_TIME_MS',value:'30000' },{ name:'CATALOG_BATCH_LEASE_SECONDS',value:'120' });
  }
  env.push({ name:'BIPLAN_PG_PASSWORD',valueFrom:{ secretKeyRef:{ name:secret,key:secretVersion } } });
  return {
    apiVersion:'run.googleapis.com/v1',kind:'Job',
    metadata:{ name:`biplan-staging-catalog-${mode}`,namespace:projectNumber,labels:{ 'cloud.googleapis.com/location':region,application:'biplan',environment:'staging' } },
    spec:{ template:{ metadata:{ annotations:{ 'run.googleapis.com/cloudsql-instances':connection,
      'run.googleapis.com/secrets':`${secret}:projects/${projectNumber}/secrets/${secret}` } },
      spec:{ taskCount:1,parallelism:1,template:{ spec:{ maxRetries:0,timeoutSeconds:'180',
        serviceAccountName:`biplan-staging-preparation@${project}.iam.gserviceaccount.com`,
        containers:[{ image,args,env,resources:{ limits:{ cpu:'1',memory:'1Gi' } } }] } } } } },
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) throw new Error('Usage: render-postgres-job.mjs SETTINGS.json');
  const bytes = await readFile(resolve(argv[0]));
  if (bytes.length > 65536) throw new Error('Staging Job settings exceed size limit');
  let input; try { input = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid staging Job settings JSON'); }
  const manifest = postgresJobManifest(input), body = `${JSON.stringify(manifest,null,2)}\n`;
  const hash = createHash('sha256').update(body).digest('hex');
  const directory = resolve(import.meta.dirname,'../work/catalog-foundation/job-manifests');
  await mkdir(directory,{ recursive:true });
  const path = resolve(directory,`${input.mode}-${hash}.json`);
  try { await writeFile(path,body,{ flag:'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || await readFile(path,'utf8') !== body) throw new Error('Job manifest write failed'); }
  console.log(JSON.stringify({ manifest:path,sha256:hash,mode:input.mode,cloudCalls:0 }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await main(); } catch (error) { console.error(String(error.message)); process.exitCode=1; }
}
