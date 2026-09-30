import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCachedPublicationCandidates, preparePublicationCandidates, searchPreparedPublication, type PreparedOfferTerm, type PreparedPublicationRead, type PreparedPublicationRepository, type PreparedPublicationSession, type PublicationSessionStatus } from '../lib/prepared-publication-search.ts';
import { emptyFilters } from '../lib/types.ts';

const now = new Date('2026-09-30T09:00:00Z');
const exact = (id: string, overrides: Partial<PreparedOfferTerm> = {}): PreparedOfferTerm => ({ offerId: `offer-${id}`, revisionId: `rev-${id}`, sourceUrl: `https://www.bubilet.com.tr/istanbul/etkinlik/${id}`, currency: 'TRY', price: '100', priceMinor: '10000', feeMinor: '0', priceKind: 'exact', availability: 'available', observedAt: now.toISOString(), ...overrides });
const projected = (id: string, overrides: Partial<PreparedOfferTerm> = {}): PreparedOfferTerm => exact(id, { evidenceVersion: 1, evidenceStatus: 'supported', evidenceReason: 'supported_page_offer',
  pageObservationId: `page-${id}`, evidenceDependencyHash: 'a'.repeat(64), evidencePolicyVersion: 'provider-page-offer-v1',
  evidenceObservedAt: now.toISOString(), ...overrides });
const session = (id: string, overrides: Record<string, unknown> = {}): PreparedPublicationSession => ({
  sessionId: id, productionId: `production-${id}`, venueId: `venue-${id}`,
  snapshot: { title: `Program ${id}`, description: 'genel etkinlik', startsAt: '2026-10-03T17:00:00Z', venue: 'Test Sahne', city: 'İstanbul', district: 'Kadıköy', address: '', category: 'Konser', imageUrl: '', offers: [{ arbitrary: { raw: true } }], ...overrides },
  document: { id: `doc-${id}`, text: `Program ${id} genel etkinlik`, hash: 'a'.repeat(64), embeddingProfile: 'test', vector: [1, ...Array(1023).fill(0)] },
  pinnedOfferTerms: [exact(id)],
});
class Repo implements PreparedPublicationRepository {
  reads: Array<string | undefined> = []; revalidations: string[][] = [];
  data: PreparedPublicationRead;
  statuses: Map<string, Partial<PublicationSessionStatus>>;
  constructor(data: PreparedPublicationRead, statuses = new Map<string, Partial<PublicationSessionStatus>>()) { this.data = data; this.statuses = statuses; }
  async readPublication(id?: string) { this.reads.push(id); return this.data; }
  async revalidatePublication(publicationId: string, ids: string[]) { this.revalidations.push(ids); return ids.map((sessionId) => ({ publicationId, sessionId, availabilityUsable: true, verifiedTotalEligible: true, canonicalSessionUsable: true, reasons: [], offers: [{ offerId: `offer-${sessionId}`, pinnedRevisionId: `rev-${sessionId}`, currentRevisionId: `rev-${sessionId}`, status: 'usable', reasons: [] }], ...this.statuses.get(sessionId) })); }
}

await test('immutable projection cache matches the oracle at each independent time boundary', () => {
  const base = exact('base', { price: '200', priceMinor: '20000', observedAt: '2026-09-30T09:30:00Z' });
  const cases = [
    { name: 'observed', term: exact('cheap', { price:'50',priceMinor:'5000',observedAt:'2026-09-30T10:00:00Z' }), before:'2026-09-30T09:59:59.999Z', at:'2026-09-30T10:00:00Z', afterPrice:50 },
    { name: 'valid-from', term: exact('cheap', { price:'50',priceMinor:'5000',observedAt:'2026-09-30T09:30:00Z',validFrom:'2026-09-30T10:30:00Z' }), before:'2026-09-30T10:29:59.999Z', at:'2026-09-30T10:30:00Z', afterPrice:50 },
    { name: 'valid-until', term: exact('cheap', { price:'50',priceMinor:'5000',observedAt:'2026-09-30T09:30:00Z',validUntil:'2026-09-30T11:00:00Z' }), before:'2026-09-30T11:00:00Z', at:'2026-09-30T11:00:00.001Z', afterPrice:200 },
    { name: 'age-expiry', term: exact('cheap', { price:'50',priceMinor:'5000',observedAt:'2026-09-30T09:00:00Z' }), before:'2026-09-30T11:59:59.999Z', at:'2026-09-30T12:00:00.001Z', afterPrice:200 },
  ];
  for (const item of cases) {
    const row = session(item.name); row.pinnedOfferTerms=[base,item.term];
    const publication={publicationId:item.name,sessions:[row]};
    for (const iso of [item.before,item.at]) {
      const date=new Date(iso), cached=prepareCachedPublicationCandidates(publication,emptyFilters,date,3*3600000);
      assert.deepEqual(cached,preparePublicationCandidates(publication,emptyFilters,date,3*3600000));
    }
    assert.equal(prepareCachedPublicationCandidates(publication,emptyFilters,new Date(item.at),3*3600000).events[0].price,item.afterPrice);
  }
  const backward=session('backward'); backward.pinnedOfferTerms=[exact('backward',{observedAt:'2026-09-30T10:00:00Z'})];
  const publication={publicationId:'backward',sessions:[backward]};
  assert.equal(prepareCachedPublicationCandidates(publication,emptyFilters,new Date('2026-09-30T10:00:00Z')).events.length,1);
  assert.equal(prepareCachedPublicationCandidates(publication,emptyFilters,new Date('2026-09-30T09:59:59.999Z')).events.length,0);
  assert.deepEqual(prepareCachedPublicationCandidates({ ...publication, sessions:[session('replacement')] },emptyFilters,now).events.map(e=>e.id),['replacement']);
  assert.deepEqual(prepareCachedPublicationCandidates(publication,emptyFilters,now,0.5),preparePublicationCandidates(publication,emptyFilters,now,0.5));
  assert.deepEqual(prepareCachedPublicationCandidates(publication,emptyFilters,now,3600000),preparePublicationCandidates(publication,emptyFilters,now,3600000));
  const invalidNow=new Date(Number.NaN);
  assert.deepEqual(prepareCachedPublicationCandidates(publication,emptyFilters,invalidNow),preparePublicationCandidates(publication,emptyFilters,invalidNow));
});

await test('cache hits isolate nested results and rerun filters, group budgets and unknown-price notice', () => {
  const row=session('isolated',{sourceSessionIds:['source-one'],attendanceTiming:{kind:'unknown',evidence:'insufficient_source_evidence'},preparedSearch:{lexicalTokens:['program']}});
  row.pinnedOfferTerms=[exact('isolated',{priceKind:'starting_at',feeMinor:null})];
  const publication={publicationId:'isolated',sessions:[row]};
  const first=prepareCachedPublicationCandidates(publication,emptyFilters,now);
  first.events[0].sourceSessionIds!.push('bad');
  first.events[0].preparedSearch!.lexicalTokens.push('bad');
  first.events[0].advertisedPrice!.amount=1;
  (first.events[0].attendanceTiming as { evidence:string }).evidence='bad';
  first.selectedOfferChecks.clear(); first.selectedOffers.clear();
  const second=prepareCachedPublicationCandidates(publication,emptyFilters,now);
  assert.deepEqual(second.events[0].sourceSessionIds,['source-one']);
  assert.deepEqual(second.events[0].preparedSearch?.lexicalTokens,['program']);
  assert.equal(second.events[0].advertisedPrice?.amount,100);
  assert.equal(second.events[0].attendanceTiming?.evidence,'insufficient_source_evidence');
  assert.equal(second.selectedOfferChecks.size,1);
  const budget=prepareCachedPublicationCandidates(publication,{...emptyFilters,maxPrice:500,partySize:2,totalBudget:1000},now);
  assert.deepEqual(budget.events,[]); assert.equal(budget.budgetExcludedUnknownPrice,1);
  const offer=projected('v2-cache');
  const projectedRow=session('v2-cache',{offerTermsVersion:2,offerTerms:[offer]}); projectedRow.pinnedOfferTerms=[offer];
  const projectedPublication={publicationId:'v2-cache',offerProjectionVersion:1,sessions:[projectedRow]};
  prepareCachedPublicationCandidates(projectedPublication,emptyFilters,now);
  const warm=prepareCachedPublicationCandidates(projectedPublication,emptyFilters,now);
  assert.equal(warm.selectedOfferChecks.get('v2-cache')?.pageObservationId,offer.pageObservationId);
  assert.equal(warm.selectedOfferChecks.get('v2-cache')?.evidenceDependencyHash,offer.evidenceDependencyHash);
});

await test('pins one publication, ignores arbitrary raw offers and revalidates every returned card', async () => {
  const repo = new Repo({ publicationId: 'old-rollback', embeddingProfile: 'test', sessions: [session('one'), session('two')] });
  const result = await searchPreparedPublication(repo, { query: 'program', filters: emptyFilters, mode: 'lexical', publicationId: 'old-rollback', now });
  assert.deepEqual(repo.reads, ['old-rollback']);
  assert.deepEqual(repo.revalidations[0]?.sort(), result.events.map((event) => event.id).sort());
  assert.equal(result.publicationId, 'old-rollback');
  assert.equal(result.events.length, 2);
  assert.equal(result.events.every((event) => event.price === 100), true);
});

await test('lost pins, changed heads and canonical session drift are excluded without replacements', async () => {
  const repo = new Repo({ publicationId: 'p1', sessions: [session('lost'), session('head'), session('drift'), session('ok')] }, new Map([
    ['lost', { publicationId: 'p2' }],
    ['head', { availabilityUsable: false, reasons: ['current_head_changed'] }],
    ['drift', { canonicalSessionUsable: false, reasons: ['session_drift'] }],
  ]));
  const result = await searchPreparedPublication(repo, { query: 'program', filters: emptyFilters, mode: 'lexical', now });
  assert.deepEqual(result.events.map((event) => event.id), ['ok']);
  assert.equal(result.shortlisted, 4);
  assert.equal(result.excludedAtRevalidation.length, 3);
});

await test('retrieval ranks the broad eligible set and keeps lexical-only records', async () => {
  const rows = Array.from({ length: 40 }, (_, index) => session(String(index)));
  rows.push(session('needle', { title: 'Zümrüt Kristal Konseri', description: 'benzersiz gösteri' }));
  const needle = rows.at(-1)!;
  needle.document = { ...needle.document!, vector: null };
  const queryVector = [1, ...Array(1023).fill(0)];
  const result = await searchPreparedPublication(new Repo({ publicationId: 'p1', embeddingProfile: 'test', sessions: rows }), { query: 'Zümrüt Kristal', filters: emptyFilters, mode: 'hybrid', queryVector, queryEmbeddingProfile: 'test', now });
  assert.equal(result.considered, 41);
  assert.equal(result.events.some((event) => event.id === 'needle'), true);
  assert.equal(result.mode, 'hybrid');
  const lexical = await searchPreparedPublication(new Repo({ publicationId: 'p1', sessions: rows }), { query: 'Zümrüt Kristal', filters: emptyFilters, mode: 'hybrid', now });
  assert.equal(lexical.mode, 'lexical');
  assert.equal(lexical.events[0]?.id, 'needle');
});

await test('budgets require exact TRY totals including known fees and party size', async () => {
  const zero = session('zero'); zero.pinnedOfferTerms = [exact('zero', { price: '0', priceMinor: '0', feeMinor: '0' })];
  const unknownFee = session('unknown-fee'); unknownFee.pinnedOfferTerms = [exact('unknown-fee', { feeMinor: null })];
  const starting = session('starting'); starting.pinnedOfferTerms = [exact('starting', { priceKind: 'starting_at' })];
  const group = session('group'); group.pinnedOfferTerms = [exact('group', { price: '90', priceMinor: '9000', feeMinor: '1000' })];
  const repo = new Repo({ publicationId: 'p1', sessions: [zero, unknownFee, starting, group] });
  const free = await searchPreparedPublication(repo, { query: '', filters: { ...emptyFilters, maxPrice: 0 }, mode: 'lexical', now });
  assert.deepEqual(free.events.map((event) => event.id), ['zero']);
  const twoPeople = await searchPreparedPublication(repo, { query: '', filters: { ...emptyFilters, maxPrice: 100, partySize: 2, totalBudget: 200 }, mode: 'lexical', now });
  assert.equal(twoPeople.events.some((event) => event.id === 'group'), true);
  assert.equal(twoPeople.events.some((event) => event.id === 'unknown-fee' || event.id === 'starting'), false);
});

await test('typed v1 terms are authoritative and exclusions remain hard constraints', async () => {
  const excluded = session('excluded', { category: 'Tiyatro', offerTermsVersion: 1, offerTerms: [exact('excluded', { priceMinor: '0' })] });
  const conflictingRaw = session('raw', { category: 'Konser', offers: [{ priceMinor: '0', feeMinor: '0' }] });
  conflictingRaw.pinnedOfferTerms = [exact('raw', { priceMinor: '50000' })];
  const result = await searchPreparedPublication(new Repo({ publicationId: 'p1', sessions: [excluded, conflictingRaw] }), { query: '', filters: { ...emptyFilters, maxPrice: 100, excludedCategories: ['Tiyatro'] }, mode: 'lexical', now });
  assert.deepEqual(result.events, []);
});

await test('rejects tampered or unsupported typed terms and unsafe exact money', async () => {
  const tampered = session('tampered', { offerTermsVersion: 1, offerTerms: [exact('tampered', { feeMinor: '1' })] });
  const unsupported = session('unsupported', { offerTermsVersion: 2, offerTerms: [exact('unsupported')] });
  const overflow = session('overflow'); overflow.pinnedOfferTerms = [exact('overflow', { price: null, priceMinor: String(Number.MAX_SAFE_INTEGER), feeMinor: '1' })];
  const mismatch = session('mismatch'); mismatch.pinnedOfferTerms = [exact('mismatch', { price: '99', priceMinor: '10000' })];
  const result = await searchPreparedPublication(new Repo({ publicationId: 'p1', sessions: [tampered, unsupported, overflow, mismatch] }), { query: '', filters: { ...emptyFilters, maxPrice: 200 }, mode: 'lexical', now });
  assert.deepEqual(result.events, []);
});

await test('invalid vectors degrade explicitly and a stale selected price offer fails final validation', async () => {
  const stale = session('stale');
  const repo = new Repo({ publicationId: 'p1', embeddingProfile: 'test', sessions: [stale] }, new Map([['stale', { offers: [{ offerId: 'offer-stale', pinnedRevisionId: 'rev-stale', currentRevisionId: 'rev-stale', status: 'stale', reasons: ['stale_observation'] }] }]]));
  const invalidQuery = [Number.NaN, ...Array(1023).fill(0)];
  const result = await searchPreparedPublication(repo, { query: '', filters: emptyFilters, mode: 'hybrid', queryVector: invalidQuery, queryEmbeddingProfile: 'test', now });
  assert.equal(result.mode, 'lexical');
  assert.deepEqual(result.events, []);
  assert.equal(result.revalidationWithheld, true);
});

await test('accepts the three real provider hosts, rejects Bubilet lookalikes and credentials, and preserves HTTPS CDN images', async () => {
  const biletinial = session('biletinial', { imageUrl: 'https://images.example-cdn.test/poster.jpg' });
  biletinial.pinnedOfferTerms = [exact('biletinial', { sourceUrl: 'https://www.biletinial.com/tr-tr/muzik/test' })];
  const biletix = session('biletix');
  biletix.pinnedOfferTerms = [exact('biletix', { sourceUrl: 'https://www.biletix.com/etkinlik/test' })];
  const badDomain = session('bad-domain');
  badDomain.pinnedOfferTerms = [exact('bad-domain', { sourceUrl: 'https://www.bubilet.com/istanbul/etkinlik/test' })];
  const credentials = session('credentials');
  credentials.pinnedOfferTerms = [exact('credentials', { sourceUrl: 'https://user@www.bubilet.com.tr/istanbul/etkinlik/test' })];
  const result = await searchPreparedPublication(new Repo({ publicationId: 'p1', sessions: [session('bubilet'), biletinial, biletix, badDomain, credentials] }), { query: '', filters: emptyFilters, mode: 'lexical', now });
  assert.deepEqual(new Set(result.events.map((event) => event.id)), new Set(['bubilet', 'biletinial', 'biletix']));
  assert.equal(result.events.find((event) => event.id === 'biletinial')?.imageUrl, 'https://images.example-cdn.test/poster.jpg');
});

await test('advertised minima remain visible without satisfying budgets or hiding missing price proof', () => {
  const row = session('advertised'); row.pinnedOfferTerms=[exact('advertised',{provider:'bubilet',priceKind:'starting_at',feeMinor:null})];
  const outsideCategory=session('other',{category:'Tiyatro'}); outsideCategory.pinnedOfferTerms=[exact('other',{feeMinor:null})];
  const publication={publicationId:'p1',sessions:[row,outsideCategory]};
  const browse=preparePublicationCandidates(publication,{...emptyFilters,category:'Konser'},now);
  assert.equal(browse.events.length,1);
  assert.equal(browse.events[0].price,null);
  assert.deepEqual(browse.events[0].advertisedPrice,{amount:100,currency:'TRY',kind:'starting_at',feesKnown:false});
  assert.equal(browse.events[0].source,'bubilet');
  const budget=preparePublicationCandidates(publication,{...emptyFilters,category:'Konser',maxPrice:500},now);
  assert.deepEqual(budget.events,[]);
  assert.equal(budget.budgetExcludedUnknownPrice,1);
  assert.equal(preparePublicationCandidates(publication,{...emptyFilters,category:'Workshop',maxPrice:500},now).budgetExcludedUnknownPrice,0);
  row.pinnedOfferTerms=[exact('advertised',{price:'99',priceMinor:'10000',feeMinor:null})];
  assert.equal(preparePublicationCandidates(publication,emptyFilters,now).events.find(e=>e.id==='advertised')?.advertisedPrice,undefined);
});

await test('v2 projection selects only supported pinned evidence and never resurrects masked raw offers', async () => {
  const unsupported = projected('a', { evidenceStatus: 'unsupported', evidenceReason: 'page_offer_unproven', sourceUrl: null,
    availability: 'unknown', price: null, priceMinor: null, feeMinor: null, priceKind: 'unknown' });
  const supported = projected('b', { provider: 'biletix', sourceUrl: 'https://www.biletix.com/etkinlik/B/ISTANBUL/tr', price: '125', priceMinor: '12500' });
  const row = session('projection', { offerTermsVersion: 2, offerTerms: [unsupported, supported],
    offers: [{ sourceUrl: 'https://www.bubilet.com.tr/istanbul/etkinlik/a', priceMinor: '1' }] });
  row.pinnedOfferTerms = [unsupported, supported];
  const repo = new Repo({ publicationId: 'p-v2', offerProjectionVersion: 1, sessions: [row] }, new Map([['projection', {
    offers: [{ offerId: supported.offerId, pinnedRevisionId: supported.revisionId, currentRevisionId: supported.revisionId, status: 'usable', reasons: [],
      pinnedPageObservationId: supported.pageObservationId, currentPageObservationId: supported.pageObservationId,
      evidenceDependencyHash: supported.evidenceDependencyHash }]
  }]]));
  const result = await searchPreparedPublication(repo, { query: '', filters: emptyFilters, mode: 'lexical', now });
  assert.equal(result.events.length, 1); assert.equal(result.events[0].price, 125); assert.equal(result.events[0].url, supported.sourceUrl);
  row.pinnedOfferTerms = [unsupported]; row.snapshot = { ...(row.snapshot as object), offerTerms: [unsupported] };
  assert.equal(preparePublicationCandidates({ publicationId: 'p-v2', offerProjectionVersion: 1, sessions: [row] }, emptyFilters, now).events.length, 0);
});

await test('v2 final validation requires the selected pinned revision, page and dependency hash', async () => {
  const offer = projected('drift');
  const row = session('drift-v2', { offerTermsVersion: 2, offerTerms: [offer] }); row.pinnedOfferTerms = [offer];
  for (const patch of [{ currentRevisionId: 'rev-new' }, { currentPageObservationId: 'page-new' }, { evidenceDependencyHash: 'b'.repeat(64) }]) {
    const status = { offerId: offer.offerId, pinnedRevisionId: offer.revisionId, currentRevisionId: offer.revisionId, status: 'usable', reasons: [],
      pinnedPageObservationId: offer.pageObservationId, currentPageObservationId: offer.pageObservationId, evidenceDependencyHash: offer.evidenceDependencyHash, ...patch };
    const result = await searchPreparedPublication(new Repo({ publicationId: 'p-v2', offerProjectionVersion: 1, sessions: [row] },
      new Map([['drift-v2', { offers: [status] }]])), { query: '', filters: emptyFilters, mode: 'lexical', now });
    assert.equal(result.events.length, 0); assert.equal(result.revalidationWithheld, true);
  }
});
