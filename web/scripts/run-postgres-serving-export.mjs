import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const integer=(value,fallback,min,max,name)=>{
  const number=value===undefined?fallback:Number(value);
  if(!Number.isSafeInteger(number)||number<min||number>max) throw new Error(`Invalid ${name}`);
  return number;
};
export function servingExportJobConfig(argv=process.argv.slice(2),env=process.env) {
  if(argv.length!==1||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,249}$/.test(argv[0])) throw new Error('Usage: run-postgres-serving-export.mjs PUBLICATION_ID');
  if(env.DEPLOYMENT_ENV!=='staging'||env.BIPLAN_GCP_PROJECT!=='biplan-staging-efeblk'||env.GCP_STORAGE_BUCKET!=='biplan-staging-efeblk-biplan-staging-data') throw new Error('Serving export requires the approved staging project and bucket');
  const config={publicationId:argv[0],bucket:env.GCP_STORAGE_BUCKET,workerId:`serving-export-${randomUUID()}`,
    pageSize:integer(env.CATALOG_EXPORT_PAGE_SIZE,1000,1,1000,'page size'),
    leaseSeconds:integer(env.CATALOG_EXPORT_LEASE_SECONDS,180,30,900,'lease'),
    processDeadlineMs:integer(env.CATALOG_PROCESS_DEADLINE_MS,120000,5000,150000,'process deadline'),
    storageRequestTimeoutMs:integer(env.CATALOG_EXPORT_GCS_TIMEOUT_MS,20000,1000,30000,'storage request timeout')};
  if(config.processDeadlineMs+5000>=config.leaseSeconds*1000) throw new Error('Serving export deadline must fit inside the lease');
  return config;
}

async function metadataWithAbort(file,signal) {
  if(signal?.aborted) throw new Error('Serving export interrupted');
  let abort;
  const aborted=new Promise((_,reject)=>{abort=()=>reject(new Error('Serving export interrupted'));signal?.addEventListener('abort',abort,{once:true});});
  try {return await Promise.race([file.getMetadata(),aborted]);}
  finally {signal?.removeEventListener('abort',abort);}
}

export function createServingExportStorage(storage,readPinned,configuredBucket) {
  return {
    readPinned:(binding,signal)=>readPinned({storage,bucket:configuredBucket,binding,signal}),
    async putCreateOnly({bucket,objectName,body,sha256,signal}) {
      if(bucket!==configuredBucket||!/^staging\/preparation\/serving\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}\.ndjson\.gz$/.test(objectName)||!objectName.endsWith(`/${sha256}.ndjson.gz`)) throw new Error('Invalid serving export destination');
      const file=storage.bucket(bucket).file(objectName);
      try {
        await pipeline(Readable.from([body]),file.createWriteStream({resumable:false,validation:'crc32c',preconditionOpts:{ifGenerationMatch:0},
          metadata:{contentType:'application/gzip',metadata:{biplanSha256:sha256}}}),{signal});
      } catch(error) {
        // An explicit repeat may find its own content-addressed upload. It is
        // always read back and verified before any database reference commits.
        if(Number(error.code)!==412) throw new Error('Serving export upload failed');
      }
      const [metadata]=await metadataWithAbort(file,signal);
      if(!/^[1-9]\d*$/.test(String(metadata?.generation))||Number(metadata.size)!==body.length) throw new Error('Serving export upload metadata mismatch');
      return {generation:String(metadata.generation)};
    },
  };
}

export async function runServingExportJob({config,dependencies,signal}) {
  const client=dependencies.createClient();
  try {return await dependencies.runExport({...config,store:dependencies.createStore(client.queryText),storage:dependencies.storage,
    encode:dependencies.encode,decode:dependencies.decode,signal});}
  finally {await client.close();}
}

async function productionDependencies(env,config) {
  const [{Storage},{createPostgresClient},{createServingExportStore},{exportPublicationServingArtifact},codec,{createExactGenerationObjectReader}]=await Promise.all([
    import('@google-cloud/storage'),import('../lib/postgres-client.node.ts'),import('../../collector/preparation/serving-export-store.mjs'),
    import('../../collector/preparation/serving-export.mjs'),import('../lib/publication-serving-artifact.node.ts'),import('../lib/gcp-clients.node.ts')]);
  const sdk=new Storage({projectId:env.BIPLAN_GCP_PROJECT,timeout:config.storageRequestTimeoutMs,retryOptions:{autoRetry:false,maxRetries:0}});
  const reader=createExactGenerationObjectReader(sdk);
  const readPinned=async({bucket,binding,signal})=>{
    if(binding.bucket!==bucket||binding.objectName!==codec.servingArtifactObjectName('staging',binding.header.publicationId,binding.compressedSha256)) throw new Error('Serving export reference mismatch');
    const bytes=await reader.read(bucket,binding.objectName,binding.generation,binding.compressedBytes,signal);
    if(bytes===null) throw new Error('Serving export object missing');
    return bytes;
  };
  return {createClient:()=>createPostgresClient({...env,BIPLAN_PG_POOL_MAX:'2',BIPLAN_PG_STATEMENT_TIMEOUT_MS:'30000'}),createStore:createServingExportStore,
    runExport:exportPublicationServingArtifact,storage:createServingExportStorage(sdk,readPinned,config.bucket),
    encode:codec.encodePublicationServingArtifact,decode:codec.decodePublicationServingArtifact};
}

export async function main(argv=process.argv.slice(2),env=process.env) {
  let config;
  try {config=servingExportJobConfig(argv,env);} catch(error) {console.error(JSON.stringify({status:'rejected',error:error.message}));return 2;}
  const controller=new AbortController(),interrupt=()=>controller.abort();
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  const timer=setTimeout(interrupt,config.processDeadlineMs);
  try {
    const result=await runServingExportJob({config,dependencies:await productionDependencies(env,config),signal:controller.signal});
    console.log(JSON.stringify(result));return ['completed','already_completed'].includes(result.status)?0:2;
  } catch(error) {
    // Do not expose arbitrary SDK/SQL exceptions or credentials.
    console.error(JSON.stringify({status:controller.signal.aborted?'interrupted':'failed',publicationId:config.publicationId,code:error.code??'export_failed',persistence:error.persistence??null}));return 1;
  } finally {clearTimeout(timer);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) process.exitCode=await main();
