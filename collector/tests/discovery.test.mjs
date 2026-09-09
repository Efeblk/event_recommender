import test from "node:test";
import assert from "node:assert/strict";
import { load } from "cheerio";
import { expandListing } from "../discovery.mjs";
import { flightObjects } from "../flight.mjs";
const listing = load(
  `<a href='/tr-tr/muzik/first'>first</a><script>var p={cityId: '147', cityUrl: 'istanbul', organizerUrl: 'muzik'}; var endpoint='/List/GetMoreItems';</script>`,
);
const item = (name) => ({ seoUrl: name, organizerUrl: "muzik" });
const biletinial = (get, options) =>
  expandListing(listing, "biletinial", "https://biletinial.com/tr-tr/muzik/istanbul", get, options);

test("scroll pagination reaches later pages and only explicit exhaustion means complete", async () => {
  const pages = [
    { items: [item("first"), item("second")], hasMore: true },
    { items: [item("third")], hasMore: false },
  ];
  const seen = [];
  const r = await biletinial(async (url) => {
    seen.push(new URL(url).searchParams.get("page"));
    return JSON.stringify(pages.shift());
  });
  assert.deepEqual(seen, ["1", "2"]);
  assert.equal(r.initial, 1);
  assert.equal(r.urls.length, 3);
  assert.equal(r.completion, "exhausted");
});
test("repeated pages, budget limits, failures and empty-with-more stay visibly incomplete", async () => {
  const page = JSON.stringify({ items: [item("second")], hasMore: true });
  const repeat = await biletinial(async () => page);
  assert.equal(repeat.completion, "repeated_page");
  assert.equal(repeat.requests.length, 2);
  assert.equal((await biletinial(async () => page, { maxPages: 1 })).completion, "page_limit");
  const failed = await biletinial(async () => {
    throw new Error("offline");
  });
  assert.equal(failed.completion, "failed:offline");
  assert.equal(failed.urls.length, 1);
  assert.equal(
    (await biletinial(async () => JSON.stringify({ items: [], hasMore: true }))).completion,
    "empty_with_more",
  );
});
test("a page containing previously discovered productions does not end pagination", async () => {
  const pages = [
    { items: [item("first")], hasMore: true },
    { items: [item("new")], hasMore: false },
  ];
  const r = await biletinial(async () => JSON.stringify(pages.shift()));
  assert.equal(r.completion, "exhausted");
  assert.equal(r.urls.length, 2);
});
test("event-group pagination uses source configuration and Istanbul filter", async () => {
  const $ = load(
    `<script>var EVENT_GROUP_ID=311;var PAGE_SIZE=1;</script><script src='/EventGroup/eventGroupIndex.js'></script>`,
  );
  const seen = [];
  const r = await expandListing(
    $,
    "biletinial",
    "https://biletinial.com/tr-tr/etkinlikleri/stand-up",
    async (raw) => {
      const u = new URL(raw);
      seen.push(u.searchParams.get("page"));
      assert.equal(u.searchParams.get("cityId"), "147");
      return JSON.stringify({
        TotalCount: 2,
        Data: [{ SeoUrl: "show-" + seen.length, tipForUrl: "tiyatro" }],
      });
    },
  );
  assert.deepEqual(seen, ["1", "2"]);
  assert.equal(r.urls.length, 2);
  assert.equal(r.completion, "exhausted");
});
const flight = (obj) =>
  load(
    `<script>self.__next_f.push([1,${JSON.stringify("1:" + JSON.stringify(obj) + "\n")}])</script>`,
  );
test("Bubilet full catalog expands the initial batch independently of virtualized DOM cards", async () => {
  const $ = flight({
    events: [{ slug: "first" }],
    citySlug: "istanbul",
    cityId: 34,
    tagId: 2,
    currentTag: { slug: "konser" },
  });
  const r = await expandListing(
    $,
    "bubilet",
    "https://www.bubilet.com.tr/istanbul/etiket/konser",
    async (url) => {
      assert.equal(url, "https://platform.api.bubilet.com.tr/v3/event/city/34/tag/2");
      return JSON.stringify([
        { slug: "first", sessions: [] },
        { slug: "later", sessions: [] },
      ]);
    },
  );
  assert.equal(r.urls.length, 2);
  assert.equal(r.completion, "exhausted");
  const bad = await expandListing(
    $,
    "bubilet",
    "https://www.bubilet.com.tr/istanbul/etiket/konser",
    async () => JSON.stringify([{ slug: "later", sessions: [] }]),
  );
  assert.equal(bad.completion, "failed:initial_batch_missing");
});
test("Biletix offsets advance and running multi-day productions remain discoverable", async () => {
  let call = 0;
  const r = await expandListing(
    load(""),
    "biletix",
    "https://www.biletix.com/search/ISTANBUL/tr",
    async (url, opts) => {
      const p = new URLSearchParams(opts.body),
        start = Number(p.get("start"));
      assert.equal(start, call++ * 100);
      assert.ok(p.getAll("fq")[0].includes(" OR end:["));
      const docs = Array.from({ length: start === 0 ? 100 : 1 }, (_, i) => ({
        id: "E" + (start + i),
        type: "event",
        city: ["İstanbul"],
        category: "MUSIC",
      }));
      return JSON.stringify({
        responseHeader: { status: 0 },
        response: { start, numFound: 101, docs },
      });
    },
  );
  assert.equal(r.urls.length, 101);
  assert.equal(r.completion, "exhausted");
});
test("malformed discovery records and changed totals cannot claim completeness", async () => {
  const r = await biletinial(async () =>
    JSON.stringify({ items: [item("../checkout")], hasMore: false }),
  );
  assert.equal(r.completion, "failed:listing_schema_changed");
  let call = 0;
  const result = await expandListing(
    load(""),
    "biletix",
    "https://www.biletix.com/search/ISTANBUL/tr",
    async () => {
      const start = call++ * 100;
      return JSON.stringify({
        responseHeader: { status: 0 },
        response: {
          start,
          numFound: call === 1 ? 101 : 102,
          docs: Array.from({ length: 100 }, (_, i) => ({
            id: "E" + i,
            type: "event",
            city: ["İstanbul"],
            category: "MUSIC",
          })),
        },
      });
    },
  );
  assert.equal(result.completion, "total_changed");
});
test("Flight parsing joins split text chunks without executing page scripts", () => {
  const text =
    "1:" + JSON.stringify({ eventSessions: [{ sessionId: 1 }], value: "literal ] ) text" }) + "\n";
  const $ = load(
    `<script>self.__next_f.push([1,${JSON.stringify(text.slice(0, 12))}])</script><script>self.__next_f.push([1,${JSON.stringify(text.slice(12))}])</script><script>throw new Error('must never run')</script>`,
  );
  assert.equal(flightObjects($)[0].eventSessions[0].sessionId, 1);
});

test("Flight text rows containing Turkish UTF-8 and newlines do not swallow subsequent JSON", () => {
  const description = "Çok satırlı açıklama\nİstanbul";
  const text =
    ':HL["style.css","style"]\n' +
    "a:T" +
    Buffer.byteLength(description).toString(16) +
    "," +
    description +
    "b:" +
    JSON.stringify({ eventSessions: [{ sessionId: 2 }] }) +
    "\n";
  const $ = load(`<script>self.__next_f.push([1,${JSON.stringify(text)}])</script>`);
  assert.equal(flightObjects($)[0].eventSessions[0].sessionId, 2);
});
