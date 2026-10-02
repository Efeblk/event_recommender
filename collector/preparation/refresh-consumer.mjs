import { performance } from 'node:perf_hooks';
import { sql as localSql,literal } from './db.mjs';

function integer(value,min,max,name) {
  if (!Number.isSafeInteger(value) || value<min || value>max) throw new Error(`Invalid ${name}`);
}
function token(value) {
  if (typeof value==='number' && !Number.isSafeInteger(value)) throw new Error('Unsafe refresh fence');
  const text=String(value);if(!/^\d+$/.test(text)) throw new Error('Invalid refresh fence');return text;
}
export function createRefreshStore(query=localSql) {
  const invoke=async expression=>JSON.parse(await query(`SELECT ${expression}::text;`));
  const owner=(request,worker)=>`${literal(request.id)},${literal(worker)},${token(request.fencing_token)}`;
  return {
    claim:async(worker,limit,seconds)=>JSON.parse(await query(`SELECT COALESCE(jsonb_agg(to_jsonb(r)||jsonb_build_object('fencing_token',r.fencing_token::text)),'[]'::jsonb)::text
      FROM biplan.claim_publication_refresh_requests(${literal(worker)},${token(limit)},make_interval(secs=>${token(seconds)})) r;`)),
    active:()=>query('SELECT publication_id FROM biplan.active_publication WHERE singleton;'),
    checkpoint:(request,worker,value)=>invoke(`biplan.checkpoint_publication_refresh_request(${owner(request,worker)},${literal(JSON.stringify(value))}::jsonb)`),
    refresh:(request,worker,base)=>invoke(`biplan.refresh_publication_request(${owner(request,worker)},${base ? literal(base) : 'NULL'})`),
    fail:(request,worker,error)=>invoke(`biplan.fail_publication_refresh_request(${owner(request,worker)},${literal(JSON.stringify(error))}::jsonb,NULL)`),
    revalidate:(publication,session,checkedAt,maxAgeSeconds=259200)=>invoke(`biplan.current_publication_offer_status(${literal(publication)},${literal(session)},${literal(checkedAt)}::timestamptz,make_interval(secs=>${token(maxAgeSeconds)}))`),
  };
}

export async function runPublicationRefresh({store,workerId,maxRequests=8,leaseSeconds=120,timeBudgetMs=30000,signal,now=()=>performance.now()}) {
  integer(maxRequests,0,100,'refresh limit');integer(leaseSeconds,1,900,'refresh lease');integer(timeBudgetMs,1,60000,'refresh claim deadline');
  if(typeof workerId!=='string' || !workerId.trim() || workerId.length>200) throw new Error('Invalid refresh worker');
  const started=now(),summary={workerId,claimed:0,completed:0,published:0,blocked:0,failures:[],receipts:[],stopped:'drained'};
  const eligible=()=>!signal?.aborted && now()-started<timeBudgetMs;
  while(summary.claimed<maxRequests && eligible()) {
    const [request]=await store.claim(workerId,1,leaseSeconds);if(!request) break;summary.claimed++;
    try {
      const base=await store.active();
      await store.checkpoint(request,workerId,{phase:'before_refresh',basePublicationId:base || null});
      if(signal?.aborted) throw new Error('Refresh worker interrupted before activation');
      const result=await store.refresh(request,workerId,base);
      if(result.status==='blocked') summary.blocked++;
      else if(result.status==='completed') {summary.completed++;if(result.resultPublicationId!==result.basePublicationId) summary.published++;}
      else throw new Error('Unsupported publication refresh receipt');
      summary.receipts.push(result);
    } catch(error) {
      const interrupted=signal?.aborted===true;
      // A changed base can be retried by a later invocation; never loop here.
      const retryable=interrupted || /active publication.*guard|base publication.*(changed|guard)|deadlock|lock timeout/i.test(String(error?.message));
      const detail={code:interrupted?'worker_interrupted':retryable?'refresh_conflict':'refresh_error',retryable,message:String(error?.message ?? error).slice(0,600)};
      let persistence='failed';
      try {const saved=await store.fail(request,workerId,detail);if(saved?.status==='pending') persistence='retry_scheduled';}
      catch {persistence='uncertain';}
      summary.failures.push({id:request.id,...detail,persistence});
      break;
    }
  }
  summary.stopped=signal?.aborted?'interrupted':summary.failures.length?'error':now()-started>=timeBudgetMs?'time_budget':summary.claimed===maxRequests && maxRequests>0?'item_limit':'drained';
  summary.elapsedMs=Math.round((now()-started)*100)/100;return summary;
}
