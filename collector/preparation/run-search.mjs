import { parseArgs } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createPublicationStore } from './publication-store.mjs';
import { work } from './db.mjs';
import { searchPreparedPublication } from '../../web/lib/prepared-publication-search.ts';
import { validateFilters } from '../../web/lib/search.ts';

const { values } = parseArgs({ options: {
  query: { type:'string', default:'' }, filters:{ type:'string', default:'{}' },
  publication:{ type:'string' }, at:{ type:'string' },
} });
const result = await searchPreparedPublication(createPublicationStore(), {
  query:values.query, filters:validateFilters(JSON.parse(values.filters)), mode:'lexical',
  publicationId:values.publication, now:values.at ? new Date(values.at) : undefined,
});
const sourceHashes = {};
for (const path of ['collector/preparation/publication-store.mjs','collector/preparation/run-search.mjs','web/lib/prepared-publication-search.ts'])
  sourceHashes[path] = createHash('sha256').update(await readFile(resolve(import.meta.dirname,'../..',path))).digest('hex');
const receipt = { at:new Date().toISOString(), runtime:process.version,
  referenceTime:values.at ?? null, historicalReplay:!!values.at,
  baseRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
  dirtyWorkingTree:execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim().length>0,
  sourceHashes, query:values.query, filters:validateFilters(JSON.parse(values.filters)), result,
  aiCalls:0, cloudChanges:false, qualification:'Local retrieval shortlist; no Jev relevance judgment or live collection.' };
const path = resolve(work,`search-run-${Date.now()}.json`);
await writeFile(path,JSON.stringify(receipt,null,2));
console.log(JSON.stringify({ ...result, events:result.events.map(e=>({ id:e.id,title:e.title,startsAt:e.startsAt,
  venue:e.venue,price:e.price,url:e.url })), receipt:path }));
