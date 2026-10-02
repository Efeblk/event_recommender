import { canonical, hash } from '../db/index.mjs';
import { responseMetadata, validateRawRef, RAW_STORE_VERSION } from '../raw/store.mjs';

function providerFor(url) {
  const host=new URL(url).hostname;
  if(['biletix.com','www.biletix.com'].includes(host)) return 'biletix';
  if(['biletinial.com','www.biletinial.com'].includes(host)) return 'biletinial';
  if(['bubilet.com.tr','www.bubilet.com.tr','platform.api.bubilet.com.tr'].includes(host)) return 'bubilet';
  throw new Error('Fetch receipt URL is outside supported provider hosts');
}
export function validateFetchLedger(value) {
  if(value===undefined) return null;
  if(!Array.isArray(value)||value.length>30000) throw new Error('Invalid bounded fetch ledger');
  const byId=new Map();
  for(const receipt of value) {
    if(!receipt?.metadata||receipt.metadata.version!==RAW_STORE_VERSION||typeof receipt.metadata.complete!=='boolean') throw new Error('Invalid fetch receipt metadata');
    const metadata=responseMetadata(receipt.metadata);
    if(canonical(metadata)!==canonical(receipt.metadata)) throw new Error('Noncanonical fetch receipt metadata');
    const ref={sha256:receipt.rawObjectRef?.sha256,key:receipt.rawObjectRef?.key,bytes:receipt.rawObjectRef?.bytes};validateRawRef(ref);
    const receiptText=JSON.stringify({...metadata,rawObjectRef:ref})+'\n';
    if(receipt.fetchId!==hash(receiptText)) throw new Error('Fetch receipt identity hash mismatch');
    const provider=providerFor(metadata.url);
    if(receipt.provider!==undefined&&receipt.provider!==provider) throw new Error('Fetch provider binding mismatch');
    const normalized={fetchId:receipt.fetchId,provider,rawObjectRef:ref,metadata,receiptText};
    const prior=byId.get(receipt.fetchId);
    if(prior&&prior.receiptText!==receiptText) throw new Error('Conflicting fetch receipt identity');
    byId.set(receipt.fetchId,normalized);
  }
  return [...byId.values()].sort((a,b)=>a.fetchId.localeCompare(b.fetchId));
}
export function requireUsableFetch(ledger,{url,observedAt,sha256}) {
  if(ledger===null) return;
  if(!ledger.some(fetch=>fetch.metadata.url===url&&fetch.metadata.fetchedAt===observedAt&&fetch.rawObjectRef.sha256===sha256&&fetch.metadata.complete&&fetch.metadata.status>=200&&fetch.metadata.status<300))
    throw new Error('Extraction dependency lacks a complete successful fetch receipt');
}
export async function persistFetchLedger(client,ledger) {
  for(const fetch of ledger??[]) {
    const metadata=fetch.metadata;
    await client.query(`INSERT INTO biplan_pipeline.fetches(id,provider,url,method,status,headers,fetched_at,collector_revision,raw_sha256,complete,receipt_text)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,[fetch.fetchId,fetch.provider,metadata.url,metadata.method,metadata.status,metadata.headers,metadata.fetchedAt,metadata.collectorRevision,fetch.rawObjectRef.sha256,metadata.complete,fetch.receiptText]);
    const row=(await client.query('SELECT * FROM biplan_pipeline.fetches WHERE id=$1',[fetch.fetchId])).rows[0];
    if(row.receipt_text!==fetch.receiptText||row.provider!==fetch.provider||row.url!==metadata.url||row.method!==metadata.method||row.status!==metadata.status||canonical(row.headers)!==canonical(metadata.headers)||new Date(row.fetched_at).getTime()!==Date.parse(metadata.fetchedAt)||row.collector_revision!==metadata.collectorRevision||row.raw_sha256!==fetch.rawObjectRef.sha256||row.complete!==metadata.complete)
      throw new Error('Immutable fetch receipt conflict');
  }
}
