import { randomUUID } from 'node:crypto';
import { hash, transaction } from '../db/index.mjs';
import { ingestCollection } from './ingest.mjs';
import { createJobStore, enqueue } from './store.mjs';
import { publishCollection, rollbackPublication } from './publication.mjs';
import { IDENTITY_RULE_VERSION } from '../identity/index.ts';
import { IDENTITY_NORMALIZATION_VERSION } from '../normalize/identity.ts';
import { extractCollection } from './extract.mjs';

const fold=text=>String(text??'').normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('tr-TR').replace(/ı/g,'i').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const ordered=list=>[...list].sort((a,b)=>a.listingId.localeCompare(b.listingId));
const revisionFor=listing=>`listing-${hash(listing)}`;
async function currentInputs(client, revisions) {
  const rows=await client.query(`SELECT l.revision_id FROM biplan_pipeline.listings l JOIN biplan_pipeline.listing_heads h ON h.listing_id=l.listing_id
    WHERE l.revision_id=ANY($1::text[]) AND h.revision_id=l.revision_id AND NOT h.withheld FOR SHARE OF h`,[revisions]);
  if(rows.rows.length!==revisions.length) throw Object.assign(new Error('Preparation input is no longer current'),{code:'stale_input'});
}
export function createPipelineStore(pool) {
  const jobs=createJobStore(pool);
  async function prepareCollection(collectionId,{resolveIdentity,normalizeTitleKey=fold,normalizeCategoryKey=fold,normalizationVersion=IDENTITY_NORMALIZATION_VERSION,prepareSearchRecord,searchVersion='1',identityVersion=IDENTITY_RULE_VERSION,embeddingCache=new Map(),embeddingProfile=null,signal,maxJobs=20000,timeBudgetMs=60000,leaseMs=30000,owner=`pipeline-${randomUUID()}`}={}) {
    if(typeof resolveIdentity!=='function') throw new Error('Identity resolver is required');
    if(!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>100000 || !Number.isFinite(timeBudgetMs)||timeBudgetMs<=0||timeBudgetMs>300000) throw new Error('Invalid preparation budget');
    const started=Date.now(),counts={normalize:0,offers:0,identity:0,search:0};
    let processed=0;
    const interrupted=()=>signal?.aborted || Date.now()-started>=timeBudgetMs || processed>=maxJobs;
    const run=async(stage,handler)=>{
      while(!interrupted()) {
        const job=await jobs.claim({collectionId,stage,owner,leaseMs});
        if(!job) break;
        try { await handler(job); processed++;counts[stage]++; }
        catch(error) { await jobs.fail(job,error,{retry:signal?.aborted===true}).catch(()=>{});throw error; }
      }
      return (await jobs.pending(collectionId,stage))===0;
    };
    const listingRows=await pool.query(`SELECT l.* FROM biplan_pipeline.collection_listings c JOIN biplan_pipeline.listings l ON l.revision_id=c.revision_id WHERE c.collection_id=$1 ORDER BY l.listing_id`,[collectionId]);
    const found=await pool.query('SELECT state FROM biplan_pipeline.collections WHERE id=$1',[collectionId]);
    if(!found.rows.length) throw new Error('Unknown collection');
    const listings=listingRows.rows.map(r=>r.body),byRevision=new Map(listingRows.rows.map(r=>[r.revision_id,r.body]));
    // Only installed profiles may be used; every cached row retains its version.
    if(normalizationVersion!==IDENTITY_NORMALIZATION_VERSION) throw new Error('Unsupported pipeline normalization version');
    const stopped=()=>({collectionId,complete:false,stopped:signal?.aborted?'interrupted':'bounded_or_pending',processed,counts});
    if(!await run('normalize',async job=>{
      const listing=byRevision.get(job.input.revisionId);
      if(!listing) throw new Error('Missing normalization input');
      const title=normalizeTitleKey(listing.title,listing.category);
      const normalized={titleKey:typeof title==='string'?title:title.key,venueKey:fold(listing.venue.name).replaceAll(' ',''),category:normalizeCategoryKey(listing.category),district:listing.venue.district??null};
      await jobs.complete(job,normalized,{collectionId,signal,
        dependents:[{stage:'offers',subject:listing.listingId,inputHash:hash(listing),input:{revisionId:job.input.revisionId},version:'1'}],
        write:async client=>{
          await currentInputs(client,[job.input.revisionId]);
          await client.query('INSERT INTO biplan_pipeline.normalized_listings VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[job.input.revisionId,normalized.titleKey,normalized.venueKey,normalized.category,normalized.district,normalized,normalizationVersion]);
        }});
    })) return stopped();
    // Reused completed normalization jobs still attach their immutable offer jobs to this collection.
    await transaction(pool,async client=>{for(const listing of listings) await enqueue(client,collectionId,{stage:'offers',subject:listing.listingId,inputHash:hash(listing),input:{revisionId:revisionFor(listing)},version:'1'});});
    if(!await run('offers',async job=>{
      const listing=byRevision.get(job.input.revisionId),id=`offer-${listing.listingId}`,revisionId=`offer-${hash(listing)}`;
      await jobs.complete(job,{id,revisionId},{signal,write:async client=>{
        await currentInputs(client,[job.input.revisionId]);
        await client.query('INSERT INTO biplan_pipeline.offers VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[revisionId,id,job.input.revisionId,listing.provider,listing.url,listing.availability,listing.observedAt,job.input_hash]);
        for(const [index,tier] of listing.tiers.entries()) {
          const price=tier.price===null?null:Math.round(tier.price*100);
          if(price!==null && !Number.isSafeInteger(price)) throw new Error('Tier price exceeds exact minor-unit range');
          await client.query(`INSERT INTO biplan_pipeline.offer_tiers(offer_revision_id,tier_index,provider_tier_id,name,price_minor,currency,availability)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[revisionId,index,tier.providerTierId??null,tier.name??null,price,tier.currency,tier.availability]);
        }
      }});
    })) return stopped();
    const buckets=new Map();
    for(const listing of listings) {
      const key=hash({city:fold(listing.city??'İstanbul'),startsAt:new Date(listing.startsAt).toISOString()});
      if(!buckets.has(key)) buckets.set(key,[]);
      buckets.get(key).push(listing);
    }
    await transaction(pool,async client=>{
      for(const [subject,bucket] of buckets) {
        const values=ordered(bucket);
        await enqueue(client,collectionId,{stage:'identity',subject,inputHash:hash(values),version:`${identityVersion}:${normalizationVersion}`,input:{listings:values}});
      }
    });
    if(!await run('identity',async job=>{
      // Optional external judgments run outside transactions. Atomic completion
      // below rechecks the fence, lease and every current listing revision.
      const input=job.input.listings,resolved=await resolveIdentity(input),map=new Map(input.map(l=>[l.listingId,l]));
      const normalized=await pool.query('SELECT revision_id,title_key FROM biplan_pipeline.normalized_listings WHERE revision_id=ANY($1::text[]) AND normalization_version=$2',[input.map(revisionFor),normalizationVersion]);
      const titleKeys=new Map(normalized.rows.map(r=>[r.revision_id,r.title_key]));
      const sessions=resolved.sessions.map(session=>{
        const members=ordered(session.listingIds.map(id=>map.get(id)));
        if(members.some(x=>!x)||new Set(members.map(l=>l.provider)).size!==members.length) throw new Error('Identity resolution violates provider uniqueness');
        if(members.some(l=>Date.parse(l.startsAt)!==Date.parse(session.startsAt))) throw new Error('Identity resolution mixed start times');
        const dependencyHash=hash({session,members}),revisionId=`session-${dependencyHash}`;
        const titleKey=titleKeys.get(revisionFor(members[0]));
        // Only a specific title supports cross-session show grouping; generic labels remain separate.
        const generic=!titleKey || /^(konser|tiyatro|stand up|gosteri|etkinlik|festival|workshop|atolye)$/.test(titleKey);
        const productionId=`production-${hash(generic?{session:session.id}:{title:titleKey,category:normalizeCategoryKey(members[0].category)})}`;
        return {...session,revisionId,productionId,dependencyHash,members};
      });
      if(new Set(sessions.flatMap(s=>s.listingIds)).size!==input.length || sessions.reduce((n,s)=>n+s.listingIds.length,0)!==input.length) throw new Error('Identity resolution must cover every listing exactly once');
      await jobs.complete(job,{sessions:sessions.map(({members,...session})=>session)},{collectionId,signal,
        dependents:sessions.map(session=>({stage:'search',subject:session.id,inputHash:session.dependencyHash,version:`${searchVersion}:${embeddingProfile??'lexical'}`,input:{session}})),
        write:async client=>{
          await currentInputs(client,input.map(revisionFor));
          for(const venue of resolved.venues) {
            const source=map.get(venue.listingIds[0]);
            await client.query(`INSERT INTO biplan_pipeline.venues(id,name,district,location,evidence)
              VALUES($1,$2,$3,CASE WHEN $4::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($5,$4),4326)::geography END,$6) ON CONFLICT DO NOTHING`,[venue.id,venue.canonicalName,source?.venue.district??null,source?.venue.geo?.lat??null,source?.venue.geo?.lon??null,JSON.stringify(venue.evidence)]);
            for(const listingId of venue.listingIds) {
              const listing=map.get(listingId);
              await client.query('INSERT INTO biplan_pipeline.venue_aliases VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[venue.id,listing.provider,listing.venue.name,listing.venue.providerVenueId??null,hash(listing.venue)]);
            }
          }
          for(const decision of resolved.decisions) await client.query(`INSERT INTO biplan_pipeline.identity_decisions(input_hash,rule_version,left_listing_id,right_listing_id,outcome,rule,evidence,model_version,calibration_version,evidence_hash,manual_override)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,[decision.inputHash,decision.ruleVersion,...decision.listingIds,decision.outcome,decision.rule,JSON.stringify(decision.evidence),decision.modelVersion??null,decision.calibrationVersion??null,decision.evidenceHash??null,decision.outcome==='manual_merge']);
          for(const session of sessions) {
            await client.query('INSERT INTO biplan_pipeline.productions VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[session.productionId,titleKeys.get(revisionFor(session.members[0])),normalizeCategoryKey(session.members[0].category)]);
            await client.query('INSERT INTO biplan_pipeline.sessions VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[session.revisionId,session.id,session.productionId,session.venueId,session.startsAt,session.city,session.dependencyHash]);
            for(const listing of session.members) await client.query('INSERT INTO biplan_pipeline.session_listings VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[session.revisionId,revisionFor(listing),listing.provider]);
          }
        }});
    })) return stopped();
    // Checkpoint replay attaches exact cached session revisions, never runs the resolver again.
    await transaction(pool,async client=>{
      const identities=await client.query(`SELECT j.output,j.input FROM biplan_pipeline.jobs j JOIN biplan_pipeline.collection_jobs c ON c.job_id=j.id WHERE c.collection_id=$1 AND j.stage='identity' AND j.state='completed'`,[collectionId]);
      for(const job of identities.rows) for(const session of job.output.sessions) {
        const members=ordered(session.listingIds.map(id=>job.input.listings.find(l=>l.listingId===id)));
        await client.query('INSERT INTO biplan_pipeline.collection_sessions(collection_id,session_id,revision_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[collectionId,session.id,session.revisionId]);
        await enqueue(client,collectionId,{stage:'search',subject:session.id,inputHash:session.dependencyHash,version:`${searchVersion}:${embeddingProfile??'lexical'}`,input:{session:{...session,members}}});
      }
    });
    if(!await run('search',async job=>{
      const session=job.input.session,first=session.members[0];
      const prepared=prepareSearchRecord?await prepareSearchRecord(session):null;
      const text=prepared?.text??[first.title,first.category,first.venue.name,first.venue.district??'',...new Set(session.members.map(l=>l.description))].join('\n');
      const lexicalTokens=prepared?.lexicalTokens??[...new Set(fold(text).split(' ').filter(Boolean))],location=prepared?.location??null;
      if(typeof text!=='string'||!Array.isArray(lexicalTokens)||lexicalTokens.some(t=>typeof t!=='string')) throw new Error('Invalid prepared search record');
      const documentHash=hash(text),id=`document-${hash({session:session.revisionId,documentHash,embeddingProfile,searchVersion,lexicalTokens,location})}`;
      const candidate=embeddingProfile?embeddingCache.get(`${embeddingProfile}:${documentHash}`):null;
      const vector=Array.isArray(candidate)&&candidate.length===1024&&candidate.every(Number.isFinite)&&candidate.some(v=>v!==0)?candidate:null;
      await jobs.complete(job,{id,documentHash,embeddingStatus:vector?'cached':'missing'},{signal,write:async client=>{
        await currentInputs(client,session.members.map(revisionFor));
        await client.query(`INSERT INTO biplan_pipeline.search_documents(id,session_revision_id,document_hash,document_text,lexical,embedding_profile,embedding,embedding_status,lexical_tokens,prepared_location)
          VALUES($1,$2,$3,$4,to_tsvector('simple',$4),$5,$6::vector,$7,$8,$9) ON CONFLICT DO NOTHING`,[id,session.revisionId,documentHash,text,embeddingProfile,vector?`[${vector.join(',')}]`:null,vector?'cached':'missing',lexicalTokens,location]);
      }});
    })) return stopped();
    if(signal?.aborted) return stopped();
    await pool.query(`UPDATE biplan_pipeline.collection_sessions cs SET search_document_id=j.output->>'id'
      FROM biplan_pipeline.collection_jobs cj JOIN biplan_pipeline.jobs j ON j.id=cj.job_id
      WHERE cs.collection_id=$1 AND cj.collection_id=cs.collection_id AND j.stage='search' AND j.state='completed'
        AND j.subject=cs.session_id AND j.input->'session'->>'revisionId'=cs.revision_id AND j.stage_version=$2`,[collectionId,`${searchVersion}:${embeddingProfile??'lexical'}`]);
    await pool.query("UPDATE biplan_pipeline.collections SET state=CASE WHEN state='published' THEN state ELSE 'prepared' END WHERE id=$1",[collectionId]);
    return {collectionId,complete:true,stopped:'drained',processed,counts};
  }
  return {jobs,ingestCollection:(input,options)=>ingestCollection(pool,input,options),extractCollection:(input,options)=>extractCollection(pool,input,options),prepareCollection,
    publish:(collectionId,options)=>publishCollection(pool,collectionId,options),rollback:options=>rollbackPublication(pool,options)};
}
