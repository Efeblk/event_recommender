import test from 'node:test';
import assert from 'node:assert/strict';
import { createAmbiguousIdentityJudge, createIdentityJevClient, decodeIdentityJudgment, identityJudgmentRequest, resolveIdentityWithJev } from '../identity/jev.ts';
const left = { listingId:'a',provider:'biletix',providerSessionIds:['a'],url:'https://www.biletix.com/etkinlik/A/ISTANBUL/tr',title:'Akustik Gecesi',description:'Canlı akustik müzik.',category:'Konser',startsAt:'2026-10-10T17:00:00Z',city:'İstanbul',venue:{name:'Test Sahne',district:'Kadıköy'} };
const right = { ...left,listingId:'b',provider:'bubilet',providerSessionIds:['b'],title:'Bir Akşam Akustik',url:'https://www.bubilet.com.tr/istanbul/etkinlik/test' };
const judgment = {outcome:'same_session',probability:0.99,confidence:0.98,probabilities:{same_session:0.99,different:0.005,insufficient_evidence:0.005},model:'jev-1.13.0',usage:{inputTokens:100,outputTokens:10}};
const calibration = {version:'heldout.v1',datasetHash:'a'.repeat(64),heldOutHash:'b'.repeat(64),heldOutPositives:5,heldOutNegatives:5,wrongMerges:0,threshold:0.95,reviewed:true};
function setup(overrides={}) {
  const stored=overrides.stored??new Map();
  const runner=createAmbiguousIdentityJudge({model:'jev-1.13.0',cache:{get:async key=>stored.get(key)??null,put:async entry=>{stored.set(entry.key,entry);}},judge:async()=>judgment,...overrides});
  return Object.assign(runner,{stored});
}
const different = {outcome:'different',probability:0.99,confidence:0.98,probabilities:{same_session:0.005,different:0.99,insufficient_evidence:0.005},model:'jev-1.13.0',usage:{inputTokens:100,outputTokens:10}};
const item = (listingId,provider,title) => ({...left,listingId,provider,title,url:`https://example.com/${listingId}`});
test('identity calls default to zero and hard guards bypass the model',async()=>{
  const runner=setup();
  assert.equal((await runner.evaluate(left,right,'v','v')).status,'budget_exhausted');
  const auto=await runner.evaluate(left,{...right,title:left.title},'v','v');
  assert.equal(auto.status,'deterministic'); assert.equal(auto.merge,true); assert.equal(auto.guard.outcome,'auto_merge');
  const manualLeft={...left,category:'Workshop',title:'Tezhip Atölyesi',venue:{name:'Fabrikafa Make & Coffee',district:'Üsküdar'}};
  const manualRight={...right,category:'Workshop',title:'İstanbul Workshops Tezhip Atölyesi',venue:{name:'İstanbul Workshops',address:'Aziz Mahmut Hüdayi, Gülfem Sk. No:15, 34672 Üsküdar/İstanbul'}};
  const manual=await runner.evaluate(manualLeft,manualRight,'v','v');
  assert.equal(manual.status,'deterministic'); assert.equal(manual.merge,true); assert.equal(manual.guard.outcome,'manual_merge');
  assert.equal((await runner.evaluate(left,{...right,provider:'biletix'},'v','v')).merge,false);
  assert.equal((await runner.evaluate(left,right,'v','another')).status,'deterministic');
  assert.equal(runner.ledger.attempted,0);
});
test('uncalibrated judgments stay unmerged, evidence changes invalidate cache and failed calls consume the cumulative budget',async()=>{
  const runner=setup({maxCalls:2});
  assert.equal((await runner.evaluate(left,right,'v','v')).merge,false);
  assert.equal((await runner.evaluate(right,left,'v','v')).status,'uncalibrated');
  assert.equal(runner.ledger.attempted,1); assert.equal(runner.ledger.cached,1);
  await runner.evaluate(left,{...right,description:'Changed evidence'},'v','v');
  assert.equal(runner.ledger.attempted,2);
  assert.equal((await runner.evaluate(left,{...right,description:'Changed again'},'v','v')).status,'budget_exhausted');
  const failure=setup({maxCalls:1,judge:async()=>{throw new Error('offline failure');}});
  assert.equal((await failure.evaluate(left,right,'v','v')).status,'optional_failure');
  assert.equal((await failure.evaluate(left,right,'v','v')).status,'budget_exhausted');
});
test('typed judgments reject malformed probabilities and model alias drift',()=>{
  assert.throws(()=>identityJudgmentRequest(left,right,'jev-latest'),/pinned/);
  assert.throws(()=>decodeIdentityJudgment({model:'jev-1.13.0',answers:{identity:{type:'choice',choice:'same_session',confidence:1,probabilities:{same_session:1,different:1,insufficient_evidence:1}}}},'jev-1.13.0'),/Invalid/);
  assert.match(identityJudgmentRequest(left,right,'jev-1.13.0').questions.identity.instructions,/untrusted/);
});

test('fresh and cached judgments enforce redundant probability equality and cache corruption fails closed',async()=>{
  const badFresh=setup({maxCalls:1,calibration,judge:async()=>({...judgment,probability:0.5})});
  assert.equal((await badFresh.evaluate(left,right,'v','v')).status,'optional_failure');
  assert.equal(badFresh.ledger.failed,1);

  const shared=new Map();
  const first=setup({stored:shared,maxCalls:1,calibration});
  assert.equal((await first.evaluate(left,right,'v','v')).merge,true);
  const entry=[...shared.values()][0];
  entry.judgment.probability=0.5;
  let calls=0;
  const replay=setup({stored:shared,maxCalls:1,calibration,judge:async()=>{calls++; return judgment;}});
  const result=await replay.evaluate(left,right,'v','v');
  assert.equal(result.status,'optional_failure'); assert.equal(result.merge,false);
  assert.equal(calls,0); assert.equal(replay.ledger.failed,1);
});

test('cache read and write failures stay optional, consume no retries, and never merge',async()=>{
  const readFailure=setup({maxCalls:1,calibration,cache:{get:async()=>{throw new Error('offline');},put:async()=>{throw new Error('unreachable');}}});
  const readResult=await readFailure.evaluate(left,right,'v','v');
  assert.equal(readResult.status,'optional_failure'); assert.equal(readResult.merge,false);
  assert.equal(readFailure.ledger.attempted,0); assert.equal(readFailure.ledger.failed,1);

  let calls=0;
  const writeFailure=setup({maxCalls:1,calibration,cache:{get:async()=>null,put:async()=>{throw new Error('offline');}},judge:async()=>{calls++; return judgment;}});
  const writeResult=await writeFailure.evaluate(left,right,'v','v');
  assert.equal(writeResult.status,'optional_failure'); assert.equal(writeResult.merge,false);
  assert.equal(calls,1); assert.equal(writeFailure.ledger.attempted,1); assert.equal(writeFailure.ledger.failed,1);
});

test('Jev client rejects oversized success bodies before JSON parsing',async()=>{
  const client=createIdentityJevClient({apiKey:'fixture',model:'jev-1.13.0',fetchImpl:async()=>new Response('x'.repeat(256001),{status:200})});
  await assert.rejects(client(left,right),/byte bound/);
});

test('zero-budget and uncalibrated wrappers leave ambiguous pairs unmerged',async()=>{
  const records=[item('a','biletix','Alpha Night'),item('b','bubilet','Beta Evening')];
  const zero=await resolveIdentityWithJev(records,setup());
  assert.equal(zero.sessions.length,2);
  const uncalibrated=await resolveIdentityWithJev(records,setup({maxCalls:1}));
  assert.equal(uncalibrated.sessions.length,2);
  assert.equal(uncalibrated.decisions[0].outcome,'unresolved');
});

test('calibrated wrapper merges only a safe provider-disjoint pair and records judgment provenance',async()=>{
  const records=[item('a','biletix','Alpha Night'),item('b','bubilet','Beta Evening')];
  const resolved=await resolveIdentityWithJev(records,setup({maxCalls:1,calibration}));
  assert.equal(resolved.sessions.length,1);
  assert.deepEqual(resolved.sessions[0].listingIds,['a','b']);
  assert.equal(resolved.decisions[0].outcome,'jev_merge');
  assert.equal(resolved.decisions[0].modelVersion,'jev-1.13.0');
  assert.equal(resolved.decisions[0].calibrationVersion,'heldout.v1');
  assert.match(resolved.decisions[0].evidenceHash,/^[a-f0-9]{64}$/);
  assert.match(resolved.decisions[0].ruleVersion,/same-session-place\.v1\+jev-1\.13\.0\+heldout\.v1$/);
  assert.notEqual(resolved.decisions[0].inputHash,resolved.decisions[0].evidenceHash);
  assert.ok(resolved.decisions[0].evidence.includes('jev-model:jev-1.13.0'));
  assert.ok(resolved.decisions[0].evidence.includes('jev-calibration:heldout.v1'));
  assert.ok(resolved.decisions[0].evidence.some(value=>value.startsWith('jev-evidence:a:')));
});

test('three-node transitivity honors a calibrated negative across the proposed cluster',async()=>{
  const records=[item('a','biletix','Alpha Night'),item('b','bubilet','Beta Evening'),item('c','biletinial','Gamma Show')];
  const runner=setup({maxCalls:3,calibration,judge:async(a,b)=>new Set([a.listingId,b.listingId]).has('a')&&new Set([a.listingId,b.listingId]).has('c')?different:judgment});
  const resolved=await resolveIdentityWithJev(records,runner);
  assert.equal(resolved.sessions.length,2);
  assert.ok(resolved.sessions.every(session=>session.listingIds.length<3));
  const negative=resolved.decisions.find(decision=>decision.listingIds.join(',')==='a,c');
  assert.equal(negative.outcome,'never_merge'); assert.equal(negative.rule,'jev-calibrated-different');
  const rejected=resolved.decisions.find(decision=>decision.listingIds.join(',')==='b,c');
  assert.equal(rejected.outcome,'unresolved'); assert.equal(rejected.rule,'jev-approved-cluster-rejected');
  assert.ok(rejected.evidence.includes('graph-pairwise-incompatibility'));
});

test('a three-provider cluster merges only after all three cross-pairs are approved',async()=>{
  const records=[item('a','biletix','Alpha Night'),item('b','bubilet','Beta Evening'),item('c','biletinial','Gamma Show')];
  const runner=setup({maxCalls:3,calibration});
  const resolved=await resolveIdentityWithJev(records,runner);
  assert.equal(resolved.sessions.length,1);
  assert.deepEqual(resolved.sessions[0].listingIds,['a','b','c']);
  assert.equal(runner.ledger.attempted,3);
  assert.ok(resolved.decisions.every(decision=>decision.outcome==='jev_merge'));
});

test('cluster joins never create duplicate providers even when every ambiguous pair is approved',async()=>{
  const records=[item('a','biletix','Alpha Night'),item('b','bubilet','Beta Evening'),item('c','biletix','Gamma Show')];
  const resolved=await resolveIdentityWithJev(records,setup({maxCalls:3,calibration}));
  assert.equal(resolved.sessions.length,2);
  for(const session of resolved.sessions) {
    const providers=session.listingIds.map(id=>records.find(record=>record.listingId===id).provider);
    assert.equal(new Set(providers).size,providers.length);
  }
  assert.ok(resolved.decisions.some(decision=>decision.rule==='jev-approved-cluster-rejected'&&decision.evidence.includes('graph-same-provider-collision')));
});

test('valid cached replay makes no model calls and reproduces the same resolution',async()=>{
  const records=[item('a','biletix','Alpha Night'),item('b','bubilet','Beta Evening')];
  const shared=new Map(); let calls=0;
  const first=await resolveIdentityWithJev(records,setup({stored:shared,maxCalls:1,calibration,judge:async()=>{calls++; return judgment;}}));
  assert.equal(calls,1);
  const replay=await resolveIdentityWithJev(records,setup({stored:shared,maxCalls:0,calibration,judge:async()=>{throw new Error('must not call');}}));
  assert.deepEqual(replay,first);
});
