import { createHash } from 'node:crypto';
import type { PublishedCatalogV1, PublishedSessionV1, RevalidatedPublishedOfferV1, SelectedPublishedOfferV1 } from '../../contracts/publication.ts';
export type CatalogQuery = (sql:string, values?:unknown[]) => Promise<{rows:Record<string,unknown>[]} >;
const canonical=(value:unknown):string=>JSON.stringify(sort(value));
function sort(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(sort);
  if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().filter(key=>(value as Record<string,unknown>)[key]!==undefined).map(key=>[key,sort((value as Record<string,unknown>)[key])]));
  return value;
}
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');

/** Every read after pin uses its supplied immutable ID. No identity or preparation runs here. */
export function createCatalogReader(query:CatalogQuery) {
  return {
    async pin():Promise<string> {
      const result=await query('SELECT publication_id FROM biplan_pipeline.active_publication WHERE singleton');
      const id=result.rows[0]?.publication_id;
      if(typeof id!=='string'||!/^publication-[a-f0-9]{64}$/.test(id)) throw new Error('No active pipeline publication');
      return id;
    },
    async read(publicationId:string):Promise<PublishedCatalogV1> {
      const result=await query('SELECT id,manifest,content_hash,session_count,offer_count FROM biplan_pipeline.publications WHERE id=$1',[publicationId]);
      if(result.rows.length!==1) throw new Error('Unknown pipeline publication');
      const meta=result.rows[0];
      const manifest=meta.manifest as PublishedCatalogV1['manifest'];
      if(manifest?.contractVersion!=='published-catalog.v1' || !Number.isSafeInteger(meta.session_count) || Number(meta.session_count)<0 || Number(meta.session_count)>20000) throw new Error('Unsupported or oversized publication');
      const sessions:PublishedSessionV1[]=[];
      let after='';
      for(;;) {
        const page=await query('SELECT session_id,body FROM biplan_pipeline.publication_sessions WHERE publication_id=$1 AND session_id COLLATE "C">$2 COLLATE "C" ORDER BY session_id COLLATE "C" LIMIT 500',[publicationId,after]);
        for(const row of page.rows) {
          const session=row.body as PublishedSessionV1;
          if(typeof row.session_id!=='string'||row.session_id<=after||session?.id!==row.session_id||!Array.isArray(session.offers)||new Set(session.offers.map(o=>o.provider)).size!==session.offers.length) throw new Error('Invalid publication session page');
          sessions.push(session);after=row.session_id;
          if(sessions.length>20000) throw new Error('Publication exceeds catalog bound');
        }
        if(page.rows.length<500) break;
      }
      if(sessions.length!==meta.session_count || sessions.length!==manifest.sessionCount || sessions.reduce((count,s)=>count+s.offers.length,0)!==meta.offer_count || meta.offer_count!==manifest.offerCount) throw new Error('Publication manifest is incomplete');
      const contentHash=hash({manifest,sessions});
      if(meta.content_hash!==contentHash || publicationId!==`publication-${contentHash}`) throw new Error('Publication content verification failed');
      return {publicationId,contentHash,manifest,sessions};
    },
    async revalidate(publicationId:string,selections:SelectedPublishedOfferV1[],checkedAt:string,maxAgeMs=72*3600000):Promise<RevalidatedPublishedOfferV1[]> {
      if(selections.length>16||new Set(selections.map(s=>s.sessionId)).size!==selections.length||!Number.isFinite(Date.parse(checkedAt))||!Number.isFinite(maxAgeMs)||maxAgeMs<=0||maxAgeMs>30*86400000) throw new Error('Invalid final source revalidation request');
      if(!selections.length) return [];
      const result=await query(`WITH selected AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x("sessionId" text,"offerId" text,"offerRevisionId" text))
        SELECT x."sessionId",x."offerId",x."offerRevisionId",po.offer_revision_id pinned_revision,o.availability,o.observed_at,
        l.starts_at,l.revision_id listing_revision,h.revision_id current_revision,h.withheld,
        EXISTS(SELECT 1 FROM biplan_pipeline.offer_tiers t WHERE t.offer_revision_id=o.revision_id AND t.availability='available') tier_available,
        NOT EXISTS(SELECT 1 FROM biplan_pipeline.publication_sessions ps JOIN biplan_pipeline.session_listings sl ON sl.session_revision_id=ps.session_revision_id
          JOIN biplan_pipeline.listings member ON member.revision_id=sl.listing_revision_id
          LEFT JOIN biplan_pipeline.listing_heads head ON head.listing_id=member.listing_id
          WHERE ps.publication_id=$1 AND ps.session_id=x."sessionId" AND (head.revision_id IS DISTINCT FROM member.revision_id OR head.withheld)) canonical_current
        FROM selected x LEFT JOIN biplan_pipeline.publication_offers po ON po.publication_id=$1 AND po.session_id=x."sessionId" AND po.offer_id=x."offerId"
        LEFT JOIN biplan_pipeline.offers o ON o.revision_id=po.offer_revision_id
        LEFT JOIN biplan_pipeline.listings l ON l.revision_id=o.listing_revision_id
        LEFT JOIN biplan_pipeline.listing_heads h ON h.listing_id=l.listing_id`,[publicationId,JSON.stringify(selections)]);
      const byId=new Map(result.rows.map(row=>[String(row.sessionId),row]));
      return selections.map(selection=>{
        const row=byId.get(selection.sessionId),reasons:string[]=[];
        if(!row || row.pinned_revision!==selection.offerRevisionId) reasons.push('offer_not_pinned');
        if(!row?.listing_revision||row.listing_revision!==row.current_revision) reasons.push('source_revision_changed');
        if(row?.withheld!==false) reasons.push('source_withheld');
        if(row?.canonical_current!==true) reasons.push('canonical_session_changed');
        if(row?.availability!=='available'||row?.tier_available!==true) reasons.push('unavailable');
        const observed=Date.parse(String(row?.observed_at)),now=Date.parse(checkedAt);
        if(!Number.isFinite(observed)||observed>now||now-observed>maxAgeMs) reasons.push('stale_source');
        const starts=Date.parse(String(row?.starts_at));
        if(!Number.isFinite(starts)||starts<now) reasons.push('session_started');
        return {...selection,usable:reasons.length===0,reasons};
      });
    },
  };
}
