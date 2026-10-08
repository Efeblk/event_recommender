import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { load } from "cheerio";
import { categorySupportedByEvent, detailUrl, discover, extract } from "../adapters.mjs";
import { MAX_EVENT_PRICE, validateEvent, reconcile, publicationGate, productionKey } from "../pipeline.mjs";
const now = new Date("2026-09-09T09:00:00Z");
const bubilet = JSON.parse(
  await readFile(new URL("./fixtures/bubilet.json", import.meta.url), "utf8"),
);
const biletix = JSON.parse(
  await readFile(new URL("./fixtures/biletix.json", import.meta.url), "utf8"),
);
const sessions = JSON.parse(
  await readFile(new URL("./fixtures/bubilet-sessions.json", import.meta.url), "utf8"),
);
const wrap = (value, state = sessions) =>
  load(
    `<script type="application/ld+json">${JSON.stringify(value)}</script>` +
      `<script>self.__next_f.push([1,${JSON.stringify("1:" + JSON.stringify(state) + "\n")}])</script>`,
  );

await test("explicit workshop and talk evidence overrides a provider music category", () => {
  assert.equal(
    categorySupportedByEvent(
      "Konser",
      "Lego ve Resimle Geleceği Tasarlıyorum Yaş Grubu: 4-7",
      "Lego ve Resimle Geleceği Tasarlıyorum Atölyesi Bu atölyede çocuklar üretir.",
    ),
    'Workshop',
  );
  assert.equal(
    categorySupportedByEvent(
      "Konser",
      "Miles: Bir Caz İkonunun Anatomisi",
      "Bu keyifli söyleşi Miles Davis'i ele alıyor. Moderatör ve panelistler katılıyor.",
    ),
    'Söyleşi',
  );
  assert.equal(
    categorySupportedByEvent(
      "Konser",
      "Yaz Konseri",
      "Sanatçıların canlı performansı Harbiye sahnesinde gerçekleşir.",
    ),
    "Konser",
  );
  assert.equal(
    categorySupportedByEvent("Konser", "Atölye Konseri", "Canlı konser bu akşam sahnelenir."),
    "Konser",
  );
  assert.equal(
    categorySupportedByEvent("Konser", "Konser Atölyesi", "Bu atölyede ritim öğrenilir."),
    'Workshop',
  );
});
const url = "https://www.bubilet.com.tr/istanbul/etkinlik/sebnem-ferah";

await test("Bubilet uses the deepest recognized breadcrumb and preserves its raw label", async () => {
  const breadcrumb = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { position: 1, name: "Konser" },
      { position: 2, name: "Workshop" },
    ],
  };
  const events = await extract(wrap([breadcrumb, bubilet]), "bubilet", url, null, now);
  assert.equal(events[0].category, "Workshop");
  assert.equal(events[0].sourceCategory, "Workshop");
});

await test("Bubilet ignores an event-self breadcrumb even when its title resembles music", async () => {
  const schema = structuredClone(bubilet);
  schema.name = "Rock Portre Çalışması";
  const breadcrumb = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { position: 3, name: schema.name, item: url },
      { position: 1, name: "Ana Sayfa" },
      { position: 2, name: "Workshop" },
    ],
  };
  const events = await extract(wrap([breadcrumb, schema]), "bubilet", url, null, now);
  assert.equal(events[0].category, "Workshop");
  assert.equal(events[0].sourceCategory, "Workshop");
});

await test("real Bubilet schema yields all three individual sessions, not aggregate price/date", async () => {
  const events = await extract(wrap(bubilet), "bubilet", url, "Konser", now);
  assert.equal(events.length, 3);
  assert.equal(events[0].price, 2500);
  assert.equal(events[0].startsAt, "2026-09-24T18:30:00.000Z");
  assert.equal(events[1].startsAt, "2026-10-17T18:30:00.000Z");
  assert.equal(events[2].venue, "Harbiye Cemil Topuzlu Açıkhava Tiyatrosu");
  assert.deepEqual(validateEvent(events[0], now), []);
  assert.equal(events[1].availability, "unknown");
  assert.equal(events[1].price, null);
  assert.deepEqual(validateEvent(events[1], now), []);
});
await test("Biletix embedded state groups ticket types and converts kurus to TRY", async () => {
  const $ = load(
    `<script id="ng-state" type="application/json">${JSON.stringify(biletix)}</script>`,
  );
  const events = await extract(
    $,
    "biletix",
    "https://www.biletix.com/etkinlik/5JBD4/ISTANBUL/tr",
    null,
    now,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].price, 520);
  assert.equal(events[0].availability, "available");
  assert.equal(events[0].startsAt, "2026-09-18T18:00:00.000Z");
});
await test("Biletix quarantines an explicit door time exported as the event start", async () => {
  const state = structuredClone(biletix);
  const detail = Object.values(state)
    .map((entry) => entry?.b?.data)
    .find((data) => data && !Array.isArray(data) && data.eventCode === "5JBD4");
  const performances = Object.values(state)
    .map((entry) => entry?.b?.data)
    .find(Array.isArray);
  for (const performance of performances)
    performance.performanceDate = Date.parse("2026-10-05T17:00:00.000Z");
  detail.eventDescription =
    "Kapı Açılış Saati: 20:00 Etkinlik Başlangıç Saati: 20:30";
  const extractState = () =>
    extract(
      load(`<script id="ng-state">${JSON.stringify(state)}</script>`),
      "biletix",
      "https://www.biletix.com/etkinlik/5JBD4/ISTANBUL/tr",
      null,
      now,
    );
  await assert.rejects(extractState(), /session_time_conflict/);

  detail.eventDescription = "Kapı açılış saati: 19:30. Etkinlik saati: 20:00.";
  assert.equal((await extractState())[0].startsAt, "2026-10-05T17:00:00.000Z");
  detail.eventDescription = "Etkinlik saati: 20:30.";
  assert.equal((await extractState())[0].startsAt, "2026-10-05T17:00:00.000Z");
});
await test("Biletinial quarantines the retained Tuz Biber door time as a start", async () => {
  const exactRecord = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: "Tuz Biber 6'lı",
    description:
      "Tuz Biber 6'lı Stand Up Gösterisi TuzBiber’in en iyi komedyenlerinin 15’er dakika sahne aldığı TuzBiber 6’lı şovu; JJ Pub Kanyon’da! Kapı Açılış Saati: 20:00 Etkinlik Başlangıç Saati: 20:30",
    startDate: "2026-10-05T20:00:00+03:00",
    location: {
      name: "JJ Pub Kanyon",
      address: { addressLocality: "İstanbul", streetAddress: "Kanyon AVM" },
    },
    offers: {
      price: 285,
      priceCurrency: "TRY",
      availability: "https://schema.org/InStock",
    },
  };
  await assert.rejects(
    () =>
      extract(
        load(`<script type="application/ld+json">${JSON.stringify(exactRecord)}</script>`),
        "biletinial",
        "https://biletinial.com/tr-tr/tiyatro/tuz-biber-6li-jj",
        "Tiyatro",
        now,
      ),
    /session_time_conflict/,
  );
});
await test("Biletix preserves high safe minor-unit prices and rejects unsafe values", async () => {
  const extractPrice = async (minorPrice) => {
    const state = structuredClone(biletix);
    for (const value of Object.values(state))
      if (Array.isArray(value.b?.data))
        for (const row of value.b.data)
          if (row.active === true && row.status === "s01_onsale") row.minPrice = minorPrice;
    const events = await extract(
      load(`<script id="ng-state">${JSON.stringify(state)}</script>`),
      "biletix",
      "https://www.biletix.com/etkinlik/5JBD4/ISTANBUL/tr",
      null,
      now,
    );
    return events[0].price;
  };
  assert.equal(await extractPrice(15000025), 150000.25);
  assert.equal(await extractPrice(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER / 100);
  assert.equal(await extractPrice(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(await extractPrice(Number.POSITIVE_INFINITY), null);
});
await test("Biletix MUSIC detail is retained as a talk when its evidence says talk", async () => {
  const state = structuredClone(biletix);
  const detail = Object.values(state)
    .map((entry) => entry?.b?.data)
    .find((data) => data && !Array.isArray(data) && data.eventCode === "5JBD4");
  detail.eventName = "Miles: Bir Caz İkonunun Anatomisi";
  detail.eventDescription = "Bu keyifli söyleşi Miles Davis'i ele alıyor. Moderatör ve panelistler katılıyor.";
  detail.eventCategoryCode = "MUSIC";
  const events = await extract(
      load(`<script id="ng-state">${JSON.stringify(state)}</script>`),
      "biletix",
      "https://www.biletix.com/etkinlik/5JBD4/ISTANBUL/tr",
      null,
      now,
  );
  assert.equal(events[0].category, 'Söyleşi');
});
await test("Biletix unknown or inactive statuses are never offered as on sale", async () => {
  const state = structuredClone(biletix);
  for (const value of Object.values(state))
    if (Array.isArray(value.b?.data))
      for (const row of value.b.data) row.status = "new_unknown_status";
  const events = await extract(
    load(`<script id="ng-state">${JSON.stringify(state)}</script>`),
    "biletix",
    "https://www.biletix.com/etkinlik/5JBD4/ISTANBUL/tr",
    null,
    now,
  );
  assert.equal(events[0].availability, "unknown");
  assert.equal(events[0].price, null);
});
await test("canonical discovery combines links and structured lists, rejects offsite paths", () => {
  const $ = load(
    `<a href="${url}?campaign=1">event</a><a href="https://evil.example/istanbul/etkinlik/test">no</a><a href="/istanbul/etkinlik/sebnem-ferah/seans/1/bilet/2">no</a>`,
  );
  assert.deepEqual(discover($, "bubilet"), [url]);
  assert.equal(
    detailUrl("https://www.biletix.com/etkinlik/5JBD4/ISTANBUL/tr/mutable-title", "biletix"),
    "https://www.biletix.com/etkinlik/5JBD4/ISTANBUL/tr",
  );
  assert.equal(
    detailUrl("https://password@www.bubilet.com.tr/istanbul/etkinlik/test", "bubilet"),
    null,
  );
});
await test("missing event schema and unverified empty output cannot erase a production", async () => {
  await assert.rejects(
    extract(load("<html>maintenance</html>"), "bubilet", url, "Konser", now),
    /schema_missing/,
  );
  const bad = { "@type": "Event", name: "unparseable redesign", startDate: "tomorrow" };
  await assert.rejects(
    extract(wrap(bad, {}), "bubilet", url, "Konser", now),
    /session_schema_missing/,
  );
});
const [event] = await extract(wrap(bubilet), "bubilet", url, "Konser", now);
await test("partial failure preserves original checkedAt; successful page replaces its old sessions", () => {
  const old = { ...event, id: "old", checkedAt: "2026-09-08T10:00:00.000Z" };
  assert.equal(reconcile([old], [], now).events[0].checkedAt, old.checkedAt);
  const changed = { ...event, id: "new" };
  assert.deepEqual(
    reconcile([old], [{ url, events: [changed] }], now).events.map((e) => e.id),
    ["new"],
  );
  assert.equal(
    reconcile([{ ...old, checkedAt: "2026-09-01T10:00:00.000Z" }], [], now).events.length,
    0,
  );
});
await test("catalog gate rejects empty and catastrophic drops", () => {
  const previous = Array.from({ length: 30 }, (_, i) => ({ ...event, id: String(i) }));
  assert.equal(publicationGate(previous, [event], { pages: [{}] }, now), "large_catalog_drop");
  assert.equal(publicationGate([], [], { pages: [] }, now), "no_verified_available_events");
  assert.equal(publicationGate([], [event], { pages: [{}] }, now), null);
});
await test("production identity deduplicates exact source matches without merging venues", () => {
  assert.equal(
    productionKey(event),
    productionKey({
      ...event,
      url: "https://elsewhere.example",
      title: event.title.toLocaleUpperCase("tr-TR"),
    }),
  );
  assert.notEqual(productionKey(event), productionKey({ ...event, venue: "Başka sahne" }));
});

await test("Bubilet truncated session state cannot replace the complete page", async () => {
  const state = structuredClone(sessions);
  state.eventSessions.pop();
  await assert.rejects(
    extract(wrap(bubilet, state), "bubilet", url, "Konser", now),
    /session_coverage_mismatch/,
  );
});
await test("Bubilet ignores a false Istanbul JSON-LD date corroborated as another city", async () => {
  const schema = structuredClone(bubilet),
    state = structuredClone(sessions),
    nonLocal = {
      ...schema.subEvent[0],
      startDate: "2026-12-10T18:00:00+00:00",
      location: {
        ...schema.subEvent[0].location,
        name: "Ankara Test Sahnesi",
        address: {
          ...schema.subEvent[0].location.address,
          addressLocality: "İstanbul",
        },
      },
    };
  schema.subEvent.push(nonLocal);
  state.allSessions.push({
    sessionId: 999,
    cityId: 6,
    date: nonLocal.startDate,
    venueName: nonLocal.location.name,
  });
  const events = await extract(wrap(schema, state), "bubilet", url, "Konser", now);
  assert.equal(events.length, state.eventSessions.length);
  assert.ok(events.some((item) => item.city === "İstanbul"));
});
await test("Bubilet excludes the real Gastro shape when eventSessions prove every session is outside Istanbul", async () => {
  const dates = ["2026-10-02T10:00:00+00:00", "2026-10-03T09:00:00+00:00", "2026-10-04T09:00:00+00:00"],
    venue = "Eskişehir Büyükşehir Belediyesi Kentpark",
    schema = {
      ...structuredClone(bubilet),
      name: "Eskişehir Gastro Fest",
      startDate: dates[0],
      location: {
        ...structuredClone(bubilet.location),
        name: venue,
        address: { ...structuredClone(bubilet.location.address), addressLocality: "İstanbul" },
      },
      subEvent: dates.map((startDate) => ({
        "@type": "Event",
        name: "Eskişehir Gastro Fest",
        startDate,
        location: {
          "@type": "Place",
          name: venue,
          address: { "@type": "PostalAddress", addressLocality: "İstanbul" },
        },
      })),
    },
    state = {
      ...structuredClone(sessions),
      eventSessions: dates.map((date, index) => ({
        sessionId: 269039 + index,
        cityId: 26,
        date,
        venueName: venue,
      })),
      allSessions: [],
    };
  const events = await extract(wrap(schema, state), "bubilet", url, "Festival", now);
  assert.deepEqual(events, []);
});
await test("Bubilet keeps conflicting detailed city evidence fail-closed", async () => {
  const schema = structuredClone(bubilet), state = structuredClone(sessions), node = schema.subEvent[0];
  state.eventSessions = [{ sessionId: 900, cityId: 26, date: node.startDate, venueName: node.location.name }];
  state.allSessions = [{ sessionId: 901, cityId: 34, date: node.startDate, venueName: node.location.name }];
  await assert.rejects(extract(wrap(schema, state), "bubilet", url, "Konser", now), /session_coverage_mismatch/);
});
await test("Bubilet keeps missing eventSessions city evidence fail-closed", async () => {
  const schema = structuredClone(bubilet), state = structuredClone(sessions), node = schema.subEvent[0];
  state.eventSessions = [{ sessionId: 900, date: node.startDate, venueName: node.location.name }];
  state.allSessions = [];
  await assert.rejects(extract(wrap(schema, state), "bubilet", url, "Konser", now), /session_coverage_mismatch/);
});
await test("Bubilet keeps ambiguous allSessions city evidence fail-closed", async () => {
  const schema = structuredClone(bubilet),
    state = structuredClone(sessions),
    missing = {
      ...schema.subEvent[0],
      startDate: "2026-12-10T18:00:00+00:00",
      location: {
        ...schema.subEvent[0].location,
        name: "Belirsiz Test Sahnesi",
      },
    };
  schema.subEvent.push(missing);
  state.allSessions.push({
    sessionId: 999,
    date: missing.startDate,
    venueName: missing.location.name,
  });
  await assert.rejects(
    extract(wrap(schema, state), "bubilet", url, "Konser", now),
    /session_coverage_mismatch/,
  );
});
await test("Bubilet unknown, calendar and conditional offers are not normal tickets", async () => {
  const state = structuredClone(sessions);
  state.eventSessions[0].isCombinedTicket = true;
  const events = await extract(wrap(bubilet, state), "bubilet", url, "Konser", now);
  assert.equal(events[0].availability, "unknown");
  assert.equal(events[0].price, null);
  state.calendarBased = true;
  await assert.rejects(
    extract(wrap(bubilet, state), "bubilet", url, "Konser", now),
    /calendar_requires_expansion/,
  );
});
await test("Bubilet additional date at another venue is read from session state", async () => {
  const state = structuredClone(sessions);
  state.eventSessions.push({
    ...state.eventSessions[0],
    sessionId: 999,
    venueName: "İkinci sahne",
    date: "2026-12-01T18:00:00+00:00",
    price: 750,
  });
  const events = await extract(wrap(bubilet, state), "bubilet", url, "Konser", now);
  assert.equal(events.length, 4);
  assert.equal(events.at(-1).venue, "İkinci sahne");
  assert.equal(events.at(-1).price, 750);
});

await test("Bubilet uses each session venue even when JSON-LD repeats the first venue", async () => {
  const schema = structuredClone(bubilet);
  schema.subEvent[2].location = structuredClone(schema.subEvent[0].location);
  const events = await extract(wrap(schema), "bubilet", url, "Konser", now);
  assert.equal(events[2].venue, sessions.eventSessions[2].venueName);
});

await test("validates legitimate high TRY prices without losing safe numeric bounds", async () => {
  const [parsed] = await extract(wrap(bubilet), "bubilet", url, "Konser", now);
  const base = { ...parsed, title: "Global Marketing Summit", price: 59400 };
  assert.deepEqual(validateEvent(base, now), []);
  assert.deepEqual(validateEvent({ ...base, price: MAX_EVENT_PRICE }, now), []);
  assert.ok(validateEvent({ ...base, price: MAX_EVENT_PRICE + 1 }, now).includes("price_outlier"));
  assert.ok(validateEvent({ ...base, price: Number.POSITIVE_INFINITY }, now).includes("price_outlier"));
});
