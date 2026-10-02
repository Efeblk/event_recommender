import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { extractListings, extractProviderListings, listingToEvent, rawObjectRefForBody } from '../extract/index.mjs';
import { validateProviderListing } from '../../contracts/listing.ts';
import { sha256Hex } from '../../contracts/hash.ts';
import { createFilesystemRawStore } from '../raw/store.mjs';

const now = '2026-09-09T09:00:00.000Z';
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const envelope = (provider, url, body) => ({ provider, url, body, fetchedAt: now, rawObjectRef: rawObjectRefForBody(body) });
const observed = (url, body, fetchedAt = now) => ({ url, body, fetchedAt, rawObjectRef: rawObjectRefForBody(body) });
const flight = (schema, state) => `<script type="application/ld+json">${JSON.stringify(schema)}</script><script>self.__next_f.push([1,${JSON.stringify(`1:${JSON.stringify(state)}\n`)}])</script>`;

test('dependency-free contract SHA-256 matches Node for UTF-8 identity inputs', () => {
  for (const value of ['', 'bubilet\n20823\n282941', 'İstanbul · Şişli 🎭'])
    assert.equal(sha256Hex(value), createHash('sha256').update(value).digest('hex'));
});

test('Biletix extraction preserves every source tier and replay is deterministic', async () => {
  const state = await fixture('biletix.json');
  const body = `<script id="ng-state" type="application/json">${JSON.stringify(state)}</script>`;
  const input = envelope('biletix', 'https://www.biletix.com/etkinlik/5JBD4/ISTANBUL/tr', body);
  const first = await extractProviderListings(input);
  const second = await extractProviderListings(structuredClone(input));
  assert.deepEqual(second, first);
  assert.equal(first.length, 1);
  assert.equal(validateProviderListing(first[0]), first[0]);
  assert.equal(first[0].providerEventId, '5JBD4');
  assert.deepEqual(first[0].providerSessionIds, ['002', '001', '003']);
  assert.deepEqual(first[0].tiers.map((tier) => [tier.providerTierId, tier.price, tier.availability]), [
    ['002', null, 'sold_out'], ['001', null, 'sold_out'], ['003', 520, 'available'],
  ]);
  assert.equal(first[0].venue.district, 'BAKIRKÖY');
  assert.deepEqual(first[0].timezoneEvidence, { kind: 'unix_epoch_ms', sourceValue: '1789754400000' });
  assert.equal(listingToEvent(first[0]).price, 520);
  assert.equal(listingToEvent(first[0]).providerListing, first[0]);
});

test('Bubilet extraction keeps address, geo and one tier per session row', async () => {
  const schema = await fixture('bubilet.json'), state = await fixture('bubilet-sessions.json');
  const body = flight(schema, state);
  const listings = await extractProviderListings(envelope('bubilet', 'https://www.bubilet.com.tr/istanbul/etkinlik/sebnem-ferah', body), { fallbackCategory: 'Konser' });
  assert.equal(listings.length, 3);
  assert.deepEqual(listings[0].venue.geo, { lat: 41.04361235, lon: 28.99297 });
  assert.match(listings[0].venue.address, /Harbiye/);
  assert.deepEqual(listings[0].tiers.map((tier) => [tier.providerTierId, tier.price, tier.availability]), [['282941', 2500, 'available']]);
  assert.equal(listings[0].providerEventId, '20823');
  assert.equal(listings[1].tiers[0].availability, 'unknown');
});

test('Biletinial preserves untruncated source fields, venue evidence and source offer rows', async () => {
  const description = 'x'.repeat(6500);
  const node = {
    '@context': 'https://schema.org', '@type': 'Event', name: 'Raw title ', description,
    startDate: '2026-10-01T18:00:00+03:00', eventStatus: 'https://schema.org/EventScheduled',
    districtName: 'Kadıköy',
    location: { name: 'Venue Raw ', address: { addressLocality: 'İstanbul', addressRegion: 'İstanbul', streetAddress: 'Raw address ' }, geo: { latitude: 41.01, longitude: 29.02 } },
    offers: [
      { '@id': 'tier-a', name: 'Ön sıra', price: '750.50', priceCurrency: 'TRY', availability: 'https://schema.org/InStock' },
      { '@id': 'tier-b', name: 'Balkon', price: '500', priceCurrency: 'TRY', availability: 'https://schema.org/SoldOut' },
    ],
  };
  const body = `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
  const input = envelope('biletinial', 'https://biletinial.com/tr-tr/tiyatro/raw-event', body);
  const [listing] = await extractProviderListings(input, { fallbackCategory: 'Tiyatro' });
  assert.equal(listing.title, 'Raw title ');
  assert.equal(listing.description.length, 6500);
  assert.deepEqual(listing.venue, { name: 'Venue Raw ', address: 'Raw address ', district: 'Kadıköy', geo: { lat: 41.01, lon: 29.02 } });
  assert.deepEqual(listing.tiers.map((tier) => [tier.providerTierId, tier.name, tier.price, tier.availability]), [
    ['tier-a', 'Ön sıra', 750.5, 'available'], ['tier-b', 'Balkon', 500, 'sold_out'],
  ]);
});

test('listing IDs never depend on title or venue names', async () => {
  const make = (title, venue) => ({
    '@context': 'https://schema.org', '@type': 'Event', name: title, description: '', startDate: '2026-10-01T18:00:00+03:00',
    location: { name: venue, address: { addressLocality: 'İstanbul' } }, offers: { price: 100, priceCurrency: 'TRY', availability: 'https://schema.org/InStock' },
  });
  const extractOne = async (node) => {
    const body = `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
    return (await extractProviderListings(envelope('biletinial', 'https://biletinial.com/tr-tr/tiyatro/stable', body), { fallbackCategory: 'Tiyatro' }))[0];
  };
  const before = await extractOne(make('Old title', 'Old venue'));
  const after = await extractOne(make('New title', 'Renamed venue'));
  assert.equal(after.listingId, before.listingId);
  assert.notEqual(after.rawObjectRef.sha256, before.rawObjectRef.sha256);
});

test('raw references are verified against the exact UTF-8 body', async () => {
  const body = '<html></html>', input = envelope('biletinial', 'https://biletinial.com/tr-tr/tiyatro/a', body);
  input.rawObjectRef.bytes++;
  await assert.rejects(extractProviderListings(input, { fallbackCategory: 'Tiyatro' }), /raw_object_ref_mismatch/);
});

test('cinema extraction replays only supplied responses and retains their raw references', async () => {
  const url = 'https://biletinial.com/tr-tr/sinema/film';
  const body = `<script>var langId=1; var countryCode='tr'; var eventId=1025;</script><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Movie', name: 'Film Raw', description: 'Full movie description' })}</script>`;
  const datesUrl = 'https://biletinial.com/tr-tr/details/GetDateListForCity?eventId=1025&langId=1&cityId=147';
  const sessionUrl = 'https://biletinial.com/dynamic/get_seances/1025/147/2026-10-01/1/tr';
  const dates = '<a data-date="2026-10-01"></a>';
  const sessions = '<div class="yn_cinema"><h2 class="yn_cinema_info_titleh2">Atlas 1948</h2><div class="yn_cinema_salon_info"><button data-title="session-1">15:30</button></div></div>';
  const supplementaryResponses = new Map([
    [datesUrl, observed(datesUrl, dates, '2026-09-09T09:00:01.000Z')],
    [sessionUrl, observed(sessionUrl, sessions, '2026-09-09T09:00:02.000Z')],
  ]);
  const [listing] = await extractProviderListings(envelope('biletinial', url, body), { fallbackCategory: 'Sinema', supplementaryResponses });
  assert.equal(listing.title, 'Film Raw');
  assert.equal(listing.description, 'Full movie description');
  assert.deepEqual(listing.providerSessionIds, ['session-1']);
  assert.equal(listing.timezoneEvidence.kind, 'istanbul_wall_time');
  assert.deepEqual(listing.supplementaryRawObjectRefs.map((ref) => ref.sha256), [rawObjectRefForBody(dates).sha256, rawObjectRefForBody(sessions).sha256]);
  assert.deepEqual(listing.supplementaryRawObservations.map(({ url, fetchedAt }) => [url, fetchedAt]), [
    [datesUrl, '2026-09-09T09:00:01.000Z'], [sessionUrl, '2026-09-09T09:00:02.000Z'],
  ]);
});

test('Cheerio orchestration accepts the retained pre-decode body reference', async () => {
  const state = await fixture('biletix.json');
  const body = `<script id="ng-state">${JSON.stringify(state)}</script>`;
  const url = 'https://www.biletix.com/etkinlik/5JBD4/ISTANBUL/tr';
  const retained = observed(url, body);
  const listings = await extractListings(load(body), 'biletix', url, null, new Date(now), { rawObjectRef: retained.rawObjectRef, supplementaryResponses: new Map([[url, retained]]) });
  assert.equal(listings.length, 1);
  assert.deepEqual(listings[0].rawObjectRef, rawObjectRefForBody(body));
});

test('Cheerio orchestration refuses to invent a primary raw reference from serialized DOM', async () => {
  const body = '<html><head></head><body><p>normalized</p></body></html>';
  const url = 'https://biletinial.com/tr-tr/tiyatro/a';
  await assert.rejects(
    extractListings(load(body), 'biletinial', url, 'Tiyatro', new Date(now), {}),
    /primary_response_not_retained/,
  );
});

test('runtime contract validator rejects arbitrary tier fields, bad raw ids and forged refs', async () => {
  const state = await fixture('biletix.json');
  const body = `<script id="ng-state">${JSON.stringify(state)}</script>`;
  const [listing] = await extractProviderListings(envelope('biletix', 'https://www.biletix.com/etkinlik/5JBD4/ISTANBUL/tr', body));
  const extraTierField = structuredClone(listing);
  extraTierField.tiers[0].invented = true;
  assert.throws(() => validateProviderListing(extraTierField), /tier/);
  const badSessionIds = structuredClone(listing);
  badSessionIds.providerSessionIds.push('');
  assert.throws(() => validateProviderListing(badSessionIds), /provider listing/i);
  const forgedRef = structuredClone(listing);
  forgedRef.rawObjectRef.key = `bodies/${'0'.repeat(64)}.bin`;
  assert.throws(() => validateProviderListing(forgedRef), /raw object reference/);
  const forgedId = structuredClone(listing);
  forgedId.listingId = '0'.repeat(64);
  assert.throws(() => validateProviderListing(forgedId), /identity/);
});

test('filesystem-retained primary and live supplementary fetches preserve exact refs and clocks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-extract-flow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFilesystemRawStore(directory);
  const url = 'https://biletinial.com/tr-tr/sinema/film';
  const body = `<script>var langId=1; var countryCode='tr'; var eventId=1025;</script><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Movie', name: 'Stored film', description: 'Stored description' })}</script>`;
  const datesUrl = 'https://biletinial.com/tr-tr/details/GetDateListForCity?eventId=1025&langId=1&cityId=147';
  const sessionUrl = 'https://biletinial.com/dynamic/get_seances/1025/147/2026-10-01/1/tr';
  const responses = new Map([[url, { body, url, fetchedAt: now }]]);
  const primaryReceipt = await store.put(Buffer.from(body), { url, status: 200, fetchedAt: now });
  responses.get(url).rawObjectRef = primaryReceipt.rawObjectRef;
  const supplied = new Map([
    [datesUrl, ['<a data-date="2026-10-01"></a>', '2026-09-09T09:00:01.000Z']],
    [sessionUrl, ['<div class="yn_cinema"><h2 class="yn_cinema_info_titleh2">Atlas</h2><div class="yn_cinema_salon_info"><button data-title="s1">15:30</button></div></div>', '2026-09-09T09:00:02.000Z']],
  ]);
  const get = async (requestUrl) => {
    const [responseBody, fetchedAt] = supplied.get(requestUrl);
    const receipt = await store.put(Buffer.from(responseBody), { url: requestUrl, status: 200, fetchedAt });
    responses.set(requestUrl, { body: responseBody, url: requestUrl, fetchedAt, rawObjectRef: receipt.rawObjectRef });
    return responseBody;
  };
  const [listing] = await extractListings(load(body), 'biletinial', url, 'Sinema', new Date(now), {
    get, rawObjectRef: primaryReceipt.rawObjectRef, supplementaryResponses: responses,
  });
  assert.equal(listing.observedAt, now);
  assert.deepEqual(await store.read(listing.rawObjectRef), Buffer.from(body));
  for (const observation of listing.supplementaryRawObservations) {
    assert.deepEqual(await store.read(observation.rawObjectRef), Buffer.from(responses.get(observation.url).body));
    assert.equal(observation.fetchedAt, responses.get(observation.url).fetchedAt);
  }
});

test('orchestration rejects a supplementary body that was not retained', async () => {
  const url = 'https://biletinial.com/tr-tr/sinema/film';
  const body = `<script>var langId=1; var countryCode='tr'; var eventId=1025;</script><script type="application/ld+json">${JSON.stringify({ '@type': 'Movie', name: 'Film' })}</script>`;
  const primary = observed(url, body);
  await assert.rejects(extractListings(load(body), 'biletinial', url, 'Sinema', new Date(now), {
    rawObjectRef: primary.rawObjectRef, supplementaryResponses: new Map([[url, primary]]), get: async () => '<a data-date="2026-10-01"></a>',
  }), /supplementary_response_not_retained/);
});
