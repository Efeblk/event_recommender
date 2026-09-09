import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { load } from "cheerio";
import { detailUrl, discover, extract } from "../adapters.mjs";
import { validateEvent, reconcile, publicationGate, productionKey } from "../pipeline.mjs";
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
const url = "https://www.bubilet.com.tr/istanbul/etkinlik/sebnem-ferah";

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
