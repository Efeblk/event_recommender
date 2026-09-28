import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';
import { extract } from '../adapters.mjs';
import { expandListing } from '../discovery.mjs';
import { validateEvent } from '../pipeline.mjs';

test('Biletix full-city search retains family, sport, museum and future unknown source formats', async () => {
  const records = ['FAMILY','SPORT','OTHER','NEW_FORMAT'].map((category,i)=>({id:`A${i}`,type:'event',city:['İstanbul'],category}));
  const discovery=await expandListing(load(''), 'biletix', 'https://www.biletix.com/search/ISTANBUL/tr', async (_url, options) => {
    const parameters=new URLSearchParams(options.body);
    assert.equal(parameters.getAll('fq').some(x=>x.startsWith('category:')), false);
    assert.equal(parameters.getAll('fq').includes('city:"İstanbul"'),true);
    return JSON.stringify({responseHeader:{status:0},response:{docs:records,start:0,numFound:4}});
  });
  assert.equal(discovery.completion,'exhausted');
  assert.equal(discovery.urls.length,4);
});

test('Biletix authoritative parent resists a music-genre subcategory and retains event-level rules', async () => {
  const state=JSON.parse(await readFile(new URL('./fixtures/biletix-workshop.json',import.meta.url),'utf8'));
  const detail=Object.values(state).map(entry=>entry?.b?.data).find(data=>data && !Array.isArray(data) && data.eventCode==='5IW60');
  detail.eventName='Yaratıcı Eğitim Programı';
  detail.eventDescription='Uygulamalı bir program.';
  detail.eventCategoryCode='EDUCATION';
  detail.subCategory='Rock';
  detail.info='<p>18 yaş ve üzeri katılımcılar içindir.</p>';
  detail.eventRules=['Kimlik kontrolü yapılır.'];
  const events=await extract(load(`<script id="ng-state">${JSON.stringify(state)}</script>`),'biletix','https://www.biletix.com/etkinlik/5IW60/ISTANBUL/tr',null,new Date('2026-09-28T14:45:00Z'));
  assert.equal(events[0].category,'Eğitim');
  assert.match(events[0].description,/Etkinlik kuralları: 18 yaş ve üzeri katılımcılar içindir\. Kimlik kontrolü yapılır\./);
  assert.doesNotMatch(events[0].description,/Loca|Tribün/);
  assert.ok(events[0].description.length<=5000);
});

test('real Biletix workshop source retains every future session and original session IDs', async () => {
  const state=JSON.parse(await readFile(new URL('./fixtures/biletix-workshop.json',import.meta.url),'utf8'));
  const now=new Date('2026-09-28T14:45:00Z');
  const performances=Object.values(state).find(x=>Array.isArray(x.b.data)).b.data;
  const events=await extract(load(`<script id="ng-state">${JSON.stringify(state)}</script>`),'biletix','https://www.biletix.com/etkinlik/5IW60/ISTANBUL/tr',null,now);
  assert.equal(events.length,performances.filter(p=>p.performanceDate>=now.getTime()).length);
  for(const event of events){
    assert.equal(event.category,'Workshop');assert.equal(event.sourceCategory,'Atölye');
    assert.equal(event.price,1100);assert.equal(event.availability,'available');
    assert.deepEqual(validateEvent(event,now),[]);
    const original=performances.find(p=>new Date(p.performanceDate).toISOString()===event.startsAt);
    assert.ok(event.sourceSessionIds.includes(String(original.performanceCode)));
    assert.equal(event.venue,original.venueName);
  }
});

test('complete expired Biletix inventory retires, while malformed session state cannot erase it', async () => {
  const state=JSON.parse(await readFile(new URL('./fixtures/biletix-workshop.json',import.meta.url),'utf8'));
  const render=()=>load(`<script id="ng-state">${JSON.stringify(state)}</script>`);
  const url='https://www.biletix.com/etkinlik/5IW60/ISTANBUL/tr';
  assert.deepEqual(await extract(render(),'biletix',url,null,new Date('2027-01-01')),[]);
  const rows=Object.values(state).find(x=>Array.isArray(x.b.data)).b.data;
  rows[0].performanceDate=null;
  await assert.rejects(extract(render(),'biletix',url,null,new Date('2027-01-01')),/session_schema_changed/);
});
