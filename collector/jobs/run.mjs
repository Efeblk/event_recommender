import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { initializePipeline } from '../db/index.mjs';
import { createPipelineStore } from './pipeline.mjs';
import { resolveIdentity, IDENTITY_RULE_VERSION } from '../identity/index.ts';
import { normalizeTitleKey, normalizeCategoryKey } from '../normalize/identity.ts';
import { validateRawRef } from '../raw/store.mjs';
import { preparePipelineSearchRecord, SEARCH_RECORD_VERSION } from './search-record.mjs';

export function pipelineConfig(argv,env) {
  if(!argv.length) throw new Error('Usage: pipeline --collection FILE|--raw-collection FILE --raw-directory DIR [--initialize] [--publish --expected-previous ID|none], or --rollback ID --expected-previous ID');
  const config={initialize:false,publish:false,maxJobs:20000,timeMs:60000};
  for(let index=0;index<argv.length;index++) {
    const flag=argv[index];
    if(flag==='--initialize'||flag==='--publish') { config[flag.slice(2)]=true;continue; }
    const fields={'--collection':'collection','--raw-collection':'rawCollection','--raw-directory':'rawDirectory','--max-jobs':'maxJobs','--time-ms':'timeMs','--expected-previous':'expectedPreviousId','--rollback':'rollback'};
    if(!fields[flag]||index+1===argv.length) throw new Error('Unknown or incomplete pipeline option');
    const value=argv[++index];config[fields[flag]]=flag==='--max-jobs'||flag==='--time-ms'?Number(value):value;
  }
  if(config.rollback ? config.collection||config.rawCollection||config.publish||config.initialize||!config.expectedPreviousId : Boolean(config.collection)===Boolean(config.rawCollection)||!config.rawDirectory) throw new Error('Invalid pipeline operation');
  if(config.publish&&!config.expectedPreviousId) throw new Error('Publish requires --expected-previous (none for first generation)');
  if(!Number.isSafeInteger(config.maxJobs)||config.maxJobs<1||config.maxJobs>100000||!Number.isSafeInteger(config.timeMs)||config.timeMs<1000||config.timeMs>300000) throw new Error('Invalid pipeline execution budget');
  if(config.expectedPreviousId==='none') config.expectedPreviousId=null;
  const host=env.BIPLAN_PG_HOST?.trim(),database=env.BIPLAN_PG_DATABASE?.trim(),user=env.BIPLAN_PG_USER?.trim();
  if(!host||!database||!user||!env.BIPLAN_PG_PASSWORD) throw new Error('Explicit PostgreSQL configuration is required');
  const local=['localhost','127.0.0.1','::1'].includes(host),socket=/^\/cloudsql\/[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$/.test(host);
  if(!local&&!socket&&env.BIPLAN_PG_TLS!=='require') throw new Error('Remote PostgreSQL requires verified TLS');
  const port=Number(env.BIPLAN_PG_PORT??5432);
  if(!Number.isSafeInteger(port)||port<1||port>65535) throw new Error('Invalid PostgreSQL port');
  config.pool={host,database,user,password:env.BIPLAN_PG_PASSWORD,port,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:5000,statement_timeout:30000,query_timeout:65000,idle_in_transaction_session_timeout:10000,
    ssl:local||socket?false:{rejectUnauthorized:true,...(env.BIPLAN_PG_CA?{ca:env.BIPLAN_PG_CA}:{})},application_name:'biplan-pipeline-preparation'};
  return config;
}
export async function runPipeline(argv=process.argv.slice(2),env=process.env) {
  const config=pipelineConfig(argv,env),pool=new pg.Pool(config.pool);
  pool.on('error',()=>console.error('Pipeline PostgreSQL connection unavailable'));
  const abort=new AbortController();
  const interrupt=()=>abort.abort();process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  try {
    if(config.initialize) await initializePipeline(pool);
    const pipeline=createPipelineStore(pool);
    if(config.rollback) return {operation:'rollback',...await pipeline.rollback({publicationId:config.rollback,expectedPreviousId:config.expectedPreviousId})};
    const collection=JSON.parse(await readFile(resolve(config.collection??config.rawCollection),'utf8')),directory=resolve(config.rawDirectory),started=Date.now();
    const readRaw=async ref=>{
      validateRawRef(ref);const path=resolve(directory,ref.key);
      if(relative(directory,path).startsWith('..')) throw new Error('Invalid raw object path');
      return readFile(path);
    };
    const extraction=config.rawCollection?await pipeline.extractCollection(collection,{readRaw,maxJobs:Math.min(config.maxJobs,6000),timeBudgetMs:config.timeMs,signal:abort.signal}):undefined;
    if(extraction&&!extraction.complete) return {operation:'extract',extraction,exitCode:2};
    const ingestion=extraction?.ingestion??await pipeline.ingestCollection(collection,{readRaw});
    const remainingJobs=config.maxJobs-(extraction?.processed??0),remainingTime=config.timeMs-(Date.now()-started);
    if(remainingJobs<1||remainingTime<1) return {operation:'prepare',ingestion,extraction,exitCode:2};
    const preparation=await pipeline.prepareCollection(collection.id,{resolveIdentity,identityVersion:IDENTITY_RULE_VERSION,normalizeTitleKey,normalizeCategoryKey,
      prepareSearchRecord:preparePipelineSearchRecord,searchVersion:SEARCH_RECORD_VERSION,maxJobs:remainingJobs,timeBudgetMs:remainingTime,signal:abort.signal});
    if(!preparation.complete) return {operation:'prepare',ingestion,preparation,exitCode:2};
    if(config.publish&&abort.signal.aborted) return {operation:'prepare',ingestion,preparation,exitCode:2};
    // A dedicated finite publication window starts after preparation; it is not
    // borrowed from the HTTP or preparation-stage SQL budget.
    const publication=config.publish?await pipeline.publish(collection.id,{expectedPreviousId:config.expectedPreviousId,processDeadlineAt:Date.now()+120000,leaseMs:120000,statementTimeoutMs:60000,signal:abort.signal}):undefined;
    return {operation:config.publish?'publish':'prepare',ingestion,extraction,preparation,publication};
  } finally {
    process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
    let timer;
    try {await Promise.race([pool.end(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Pipeline pool close exceeded its budget'),{code:'close_budget'})),10000);})]);}
    finally {clearTimeout(timer);}
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  runPipeline().then(result=>{console.log(JSON.stringify(result));process.exitCode=result.exitCode??0;},error=>{
    // Driver diagnostics can include connection/SQL data. Report only a bounded error code.
    console.error(JSON.stringify({operation:'pipeline',status:'failed',code:/^[a-zA-Z0-9_]{1,64}$/.test(error.code??'')?error.code:'pipeline_failed',message:error instanceof SyntaxError?'Invalid JSON collection input':'Pipeline failed; check explicit configuration and preserved input.'}));process.exitCode=1;
  });
}
