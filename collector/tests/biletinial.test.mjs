import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "cheerio";
import { canRetireBiletinialDetail, collectBiletinialKids, collectBiletinialListing, discoverBiletinialCategories, discoverBiletinialDetails, expandBiletinialSessions, extractBiletinial, parseBiletinialListingConfig } from "../biletinial.mjs";

const menu = `<ul class="siteNav"><li><a href="/tr-tr/tiyatro" title="Tiyatro">Tiyatro</a></li><li><a href="/tr-tr/egitim" title="Egitim">Egitim</a></li><li><a href="/tr-tr/etkinlikleri/stand-up">Stand Up</a></li><li><a href="/tr-tr/spor">Spor</a></li><li><a href="/tr-tr/futbol">Futbol</a></li></ul><div class="yhm_kategori_cocuk"><h3>Çocuklar İçin</h3><a href="/tr-tr/kids">Tiyatro</a><a href="/tr-tr/kids">Atölyeler</a></div>`;
const page = `<option data-name="İstanbul (Tümü)" value="istanbul" data-id="147"></option><input id="categoryPageSize" value="2"><input id="categoryListCount" value="3"><input id="categoryOrganizerType" value="Education"><script>var p={organizerUrl:'egitim'};</script>`;
const listingFixture = JSON.parse(readFileSync(new URL("./fixtures/biletinial-listing.json", import.meta.url), "utf8"));

test("discovers the complete source menu and derives Istanbul listing paths", () => {
  assert.deepEqual(discoverBiletinialCategories(menu).map(({ path, istanbulPath, category }) => [path, istanbulPath, category]), [
    ["/tr-tr/tiyatro", "/tr-tr/tiyatro/istanbul", "Tiyatro"],
    ["/tr-tr/egitim", "/tr-tr/egitim/istanbul", "Eğitim"],
    ["/tr-tr/etkinlikleri/stand-up", "/tr-tr/etkinlikleri/stand-up/istanbul", "Stand-up"],
    ["/tr-tr/spor", "/tr-tr/spor/istanbul", "Spor"],
    ["/tr-tr/futbol", "/tr-tr/futbol", "Spor"],
    ["/tr-tr/kids", "/tr-tr/kids", "Diğer"],
  ]);
  assert.deepEqual(discoverBiletinialCategories(menu).map(({ listingKind }) => listingKind), ["list", "list", "event-group", "sports", "football", "kids"]);
});

test("kids uses the observed one-response Istanbul aggregate and retains every format URL", async () => {
  const result = await collectBiletinialKids(async (url) => {
    assert.equal(new URL(url).pathname, "/tr-tr/List/GetKidsEvents");
    assert.equal(new URL(url).searchParams.get("cityId"), "147");
    return JSON.stringify({ Events: [
      { SeoUrl: "cocuk-tiyatrosu", OrganizerTypeUrl: "tiyatro" },
      { SeoUrl: "cocuk-atolyesi", OrganizerTypeUrl: "egitim" },
      { SeoUrl: "cocuk-filmi", OrganizerTypeUrl: "sinema" },
    ] });
  });
  assert.equal(result.completion, "exhausted");
  assert.deepEqual(result.urls, [
    "https://biletinial.com/tr-tr/tiyatro/cocuk-tiyatrosu",
    "https://biletinial.com/tr-tr/egitim/cocuk-atolyesi",
    "https://biletinial.com/tr-tr/sinema/cocuk-filmi",
  ]);
});

test("requires source-observed Istanbul city configuration", () => {
  assert.deepEqual(parseBiletinialListingConfig(page, "https://biletinial.com/tr-tr/egitim/istanbul"), {
    cityId: 147, cityUrl: "istanbul", organizerUrl: "egitim", organizerType: "Education", pageSize: 2, totalCount: 3,
  });
  assert.throws(() => parseBiletinialListingConfig(page.replace('data-id="147"', 'data-id="5"'), "https://biletinial.com/tr-tr/egitim/istanbul"), /istanbul_config_missing/);
});

test("discovers the server-rendered first batch independently of pagination", () => {
  assert.deepEqual(discoverBiletinialDetails(`<ul id="eventListContainer"><li><a href="/tr-tr/egitim/a">A</a><a href="/tr-tr/egitim/a">again</a></li></ul>`), ["https://biletinial.com/tr-tr/egitim/a"]);
});

test("discovers verified server-rendered sports and football detail links", () => {
  const html = `<ul><li data-link="/tr-tr/spor/voleybol-maci" data-city="77"></li></ul><div class="kategori__etkinlikler_futbol"><h3><a href="/tr-tr/spor/futbol-maci">Maç</a></h3></div>`;
  assert.deepEqual(discoverBiletinialDetails(html), [
    "https://biletinial.com/tr-tr/spor/voleybol-maci",
    "https://biletinial.com/tr-tr/spor/futbol-maci",
  ]);
});

test("paginates serially until source count proves exhaustion", async () => {
  const pages = [{ items: [{ seoUrl: "a" }, { seoUrl: "b" }], TotalCount: 3 }, { items: [{ seoUrl: "c" }], TotalCount: 3 }], seen = [];
  const result = await collectBiletinialListing(parseBiletinialListingConfig(page, "https://biletinial.com/tr-tr/egitim/istanbul"), async (url) => {
    seen.push(new URL(url).searchParams); return JSON.stringify(pages.shift());
  }, { initialCount: 0 });
  assert.equal(result.completion, "exhausted"); assert.equal(result.items.length, 3);
  assert.deepEqual(seen.map((params) => [params.get("page"), params.get("cityId"), params.get("cityUrl")]), [["1", "147", "istanbul"], ["2", "147", "istanbul"]]);
});

test("hasMore, changing totals, and incomplete initial batches cannot claim exhaustion", async () => {
  const config = parseBiletinialListingConfig(page, "https://biletinial.com/tr-tr/egitim/istanbul");
  const short = await collectBiletinialListing(config, async () => JSON.stringify({ items: [{ seoUrl: "a" }], TotalCount: 3, hasMore: true }), { initialCount: 0 });
  assert.equal(short.completion, "short_page_with_more");
  let call = 0;
  const changed = await collectBiletinialListing(config, async () => JSON.stringify(call++ ? { items: [], TotalCount: 4, hasMore: false } : { items: [{ seoUrl: "a" }, { seoUrl: "b" }], TotalCount: 3, hasMore: true }), { initialCount: 0 });
  assert.equal(changed.completion, "changed_total");
  const incomplete = await collectBiletinialListing(config, async () => JSON.stringify({ items: [], TotalCount: 3, hasMore: false }), { initialCount: 1 });
  assert.equal(incomplete.completion, "incomplete_total");
  let requested = false;
  const completeInitial = await collectBiletinialListing(config, async () => { requested = true; return "{}"; }, { initialCount: 3 });
  assert.equal(completeInitial.completion, "exhausted"); assert.equal(requested, false);
});

test("expands all supplied sessions and quarantines open or invalid rows", () => {
  const now = new Date("2026-09-28T00:00:00Z");
  const result = expandBiletinialSessions(listingFixture.items, "Workshop", now);
  assert.equal(result.events.length, 2); assert.equal(result.unresolved.length, 1);
  assert.notEqual(result.events[0].id, result.events[1].id);
  assert.equal(result.events[0].price, null); assert.equal(result.events[0].availability, "unknown");
});

test("detail extraction keeps every verified Istanbul Event and rejects other-city sessions", async () => {
  const schema = (city, date) => ({ "@context": "https://schema.org", "@type": "Event", name: "Atölye", description: "Katılımcı atölyesi", startDate: date, url: "https://biletinial.com/tr-tr/egitim/atolye", location: { "@type": "Place", name: "Mekan", address: { "@type": "PostalAddress", addressRegion: city, addressLocality: city, streetAddress: "Adres" } }, offers: { "@type": "Offer", price: 500, priceCurrency: "TRY", availability: "https://schema.org/InStock" } });
  const $ = load(`<script type="application/ld+json">${JSON.stringify([schema("İstanbul Anadolu", "2026-10-01T18:00:00+03:00"), schema("İstanbul Avrupa", "2026-10-02T18:00:00+03:00"), schema("İzmir", "2026-10-03T18:00:00+03:00")])}</script>`);
  const events = await extractBiletinial($, "https://biletinial.com/tr-tr/egitim/atolye", "Eğitim", new Date("2026-09-28T00:00:00Z"), { categoryForEvent: () => "Workshop" });
  assert.equal(events.length, 2); assert.ok(events.every((event) => event.category === "Workshop" && event.sourceVersion === "4"));
});

test("detail extraction delegates nested sessions, offers and status to the shared source contract", async () => {
  const offer = (price, availability = "https://schema.org/InStock") => ({ price, priceCurrency: "TRY", availability });
  const session = (date, status, offers) => ({ "@type": "Event", name: "Çocuk Atölyesi", description: "Atölye", startDate: date, eventStatus: status, location: { name: "Mekan", address: { addressLocality: "İstanbul", streetAddress: "Adres" } }, offers });
  const graph = { "@context": "https://schema.org", "@graph": [{ "@type": "Event", name: "Aggregate", subEvent: [
    session("2026-10-01T18:00:00+03:00", "https://schema.org/EventScheduled", [offer("750"), offer("500")]),
    session("2026-10-02T18:00:00+03:00", "https://schema.org/EventCancelled", [offer("100")]),
    session("2026-10-03T18:00:00+03:00", "https://schema.org/EventScheduled", [offer("400", "https://schema.org/SoldOut")]),
  ] }] };
  const events = await extractBiletinial(load(`<script type="application/ld+json">${JSON.stringify(graph)}</script>`), "https://biletinial.com/tr-tr/egitim/cocuk-atolyesi", "Eğitim", new Date("2026-09-28T00:00:00Z"));
  assert.deepEqual(events.map(({ price, availability }) => [price, availability]), [[500, "available"], [100, "cancelled"], [null, "sold_out"]]);
  assert.ok(events.every((event) => event.sourceVersion === "4"));
});

test("Movie metadata without public venue sessions is never fabricated", async () => {
  const $ = load(`<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Movie", name: "Film" })}</script>`);
  await assert.rejects(() => extractBiletinial($, "https://biletinial.com/tr-tr/sinema/film", "Sinema"), /cinema_sessions_require_public_contract/);
});

test("non-cinema coming-soon prose is not treated as a verified session contract", async () => {
  // Reduced from the 2026-09-28 Ati242 source response (eventId 66832). The
  // page visibly mentions a date and venue, but publishes no Event JSON-LD or
  // session row and labels the ticket action "Çok Yakında". The site's date
  // and seance endpoints are guarded by organizerType == 1 (cinema), so the
  // collector must not call them for organizerType 3 or revive a stale offer.
  const $ = load(`<h1>Ati242 Konseri</h1>
    <button class="goseances">Çok Yakında</button>
    <div class="tabContent"><p>ATİ242 – 11 EKİM / MAXIMUM UNIQ AÇIKHAVA</p></div>
    <script>var organizerType = 3; var eventId = 66832; var cinemaId = 0;</script>`);
  let called = false;
  await assert.rejects(() => extractBiletinial(
    $,
    "https://biletinial.com/tr-tr/muzik/ati242-konseri-biletleri",
    "Konser",
    new Date("2026-09-28T00:00:00Z"),
    { get: async () => { called = true; return ""; } },
  ), /schema_missing/);
  assert.equal(called, false);
});

test("cinema follows the observed public date and session HTML contracts serially", async () => {
  const $ = load(`<script>var langId=1; var countryCode='tr'; var eventId=1025;</script><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Movie", name: "Film", description: "Açıklama" })}</script>`);
  const calls = [], get = async (url) => {
    calls.push(url);
    if (url.includes("GetDateListForCity")) return `<a data-date="2026-10-01"></a><a data-date="2026-10-02"></a>`;
    const date = url.includes("2026-10-01") ? "01 Ekim 2026" : "02 Ekim 2026";
    return `<div class="yn_cinema"><h2 class="yn_cinema_info_titleh2">Atlas 1948</h2><span>${date}</span><div class="yn_cinema_salon_info"><button data-title="${calls.length}"> 15:30 </button></div></div>`;
  };
  const events = await extractBiletinial($, "https://biletinial.com/tr-tr/sinema/film", "Sinema", new Date("2026-09-28T00:00:00Z"), { get });
  assert.equal(events.length, 2); assert.equal(calls.length, 3);
  assert.ok(calls[0].includes("eventId=1025") && calls[0].includes("cityId=147"));
  assert.equal(events[0].venue, "Atlas 1948"); assert.equal(events[0].price, null);
});

test("unqualified Event datetimes are rejected", async () => {
  const node = { "@context": "https://schema.org", "@type": "Event", name: "Etkinlik", description: "", startDate: "2026-10-01T18:00:00", location: { name: "Mekan", address: { addressRegion: "İstanbul" } } };
  await assert.rejects(() => extractBiletinial(load(`<script type="application/ld+json">${JSON.stringify(node)}</script>`), "https://biletinial.com/tr-tr/egitim/a", "Eğitim"), /no_verified_istanbul_sessions/);
});

test("retires only conclusively past or explicitly other-city leaf Events", async () => {
  const event = (startDate, locality = "İstanbul", venue = "Mekan") => ({ "@type": "Event", name: "Etkinlik", startDate, location: { name: venue, address: { addressLocality: locality } } });
  const pageOf = (...nodes) => load(`<script type="application/ld+json">${JSON.stringify(nodes)}</script>`);
  const now = new Date("2026-09-28T00:00:00Z");
  assert.equal(canRetireBiletinialDetail(pageOf(event("2026-09-27T18:00:00+03:00")), now), true);
  assert.equal(canRetireBiletinialDetail(pageOf(event("2026-10-01T18:00:00+03:00", "İzmir")), now), true);
  assert.deepEqual(await extractBiletinial(pageOf(event("2026-09-27T18:00:00+03:00")), "https://biletinial.com/tr-tr/etkinlik/gecmis", "Diğer", now), []);
  assert.equal(canRetireBiletinialDetail(pageOf(event("2026-10-01T18:00:00")), now), false);
  assert.equal(canRetireBiletinialDetail(pageOf(event("2026-10-01T18:00:00+03:00", "İstanbul", "")), now), false);
  assert.equal(canRetireBiletinialDetail(pageOf(event("2026-10-01T18:00:00+03:00", "")), now), false);
});
