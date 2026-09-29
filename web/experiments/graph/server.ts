import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { GraphClient } from './client.ts';
import { loadSnapshot } from './snapshot.ts';
import { graphSearch, type GraphSearchInput } from './search.ts';

const snapshot = await loadSnapshot(), graph = new GraphClient();
const readiness = await graph.query("MATCH (n:PrototypeSnapshot {id:'active'}) RETURN n.state AS state,n.catalogHash AS hash");
if (readiness[0]?.state !== 'ready' || readiness[0]?.hash !== snapshot.provenance.catalogHash) throw Error('Load the matching graph snapshot before starting the demo');
const vectors = new Map(snapshot.vectors.entries.map(row=>[row.hash,row.vector]));
const html = await readFile(new URL('./demo.html',import.meta.url));
const server = createServer(async (req,res) => {
  const json=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try {
    if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;}
    if(req.method==='GET'&&req.url==='/api/meta') {json(200,{...snapshot.projection.summary,frozenAt:snapshot.at.toISOString(),neighborhoods:snapshot.projection.neighborhoods.map(n=>n.name),
      probes:snapshot.events.filter(e=>e.category==='Workshop'&&vectors.has(e.preparedSearch!.documentHash)).slice(0,40).map(e=>({id:e.id,title:e.title,venue:e.venue}))});return;}
    if(req.method==='POST'&&req.url==='/api/search') {
      let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>32768){json(413,{error:'Request too large'});return;}}
      const parsed=JSON.parse(body) as GraphSearchInput & {probeSessionId?:string};
      const input:GraphSearchInput={filters:parsed.filters,query:parsed.query,requirements:parsed.requirements,preferences:parsed.preferences,neighborhood:parsed.neighborhood};
      if(parsed.probeSessionId){const event=snapshot.eventMap.get(parsed.probeSessionId);const vector=event&&vectors.get(event.preparedSearch!.documentHash);if(!vector)throw Error('Unknown cached vector probe');input.queryVector=vector;}
      const result=await graphSearch(graph,snapshot.eventMap,input);
      json(200,{eligible:result.eligible.length,vectorCandidates:result.denseScores?.size??0,timings:result.timings,
        candidates:result.shortlist,finalJevJudgmentRun:false,frozenAt:snapshot.at.toISOString(),vectorMode:input.queryVector?'cached document probe':'lexical only'});return;
    }
    json(404,{error:'Not found'});
  } catch(error){json(400,{error:error instanceof Error?error.message:'Invalid request'});}
});
server.listen(4175,'127.0.0.1',()=>console.log('Graph search demo: http://127.0.0.1:4175 (local frozen catalog; no paid API calls)'));
