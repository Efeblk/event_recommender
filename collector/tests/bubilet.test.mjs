import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { load } from "cheerio";
import {
  bubiletDetailInventory,
  bubiletTaxonomy,
  discoverBubiletCity,
  verifiedBubiletDetailInventory,
} from "../bubilet.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/bubilet-city.json", import.meta.url), "utf8"),
);
const flight = (value) =>
  load(
    `<script>self.__next_f.push([1,${JSON.stringify("1:" + JSON.stringify(value) + "\n")}])</script>`,
  );

test("Bubilet taxonomy retains every exposed tag, including non-homepage formats", () => {
  assert.deepEqual(
    bubiletTaxonomy(flight(fixture)).map(({ id, slug, name }) => ({ id, slug, name })),
    [
      { id: 6, slug: "trendler", name: "Trendler" },
      { id: 37, slug: "spor-etkinlikleri", name: "Spor" },
      { id: 50, slug: "workshop", name: "Workshop" },
      { id: 306, slug: "-", name: "-" },
    ],
  );
});

test("city discovery unions all tags and preserves overlapping source labels", async () => {
  const rows = new Map([
    [6, [{ slug: "film", sessions: [] }]],
    [37, [{ slug: "sport", sessions: [{}] }]],
    [50, [{ slug: "workshop", sessions: [{}] }, { slug: "film", sessions: [{}] }]],
    [306, []],
  ]);
  const result = await discoverBubiletCity(flight(fixture), async (url) => {
    const id = Number(url.split("/").at(-1));
    return JSON.stringify(rows.get(id));
  });
  assert.equal(result.completion, "exhausted");
  assert.deepEqual(result.productions.map((item) => item.slug), ["film", "sport", "workshop"]);
  assert.deepEqual(
    result.productions.find((item) => item.slug === "film").sourceCategories.map((tag) => tag.name),
    ["Trendler", "Workshop"],
  );
});

test("bounded taxonomy work reports a resumable backlog and never claims exhaustion", async () => {
  const first = await discoverBubiletCity(
    flight(fixture),
    async () => JSON.stringify([{ slug: "first", sessions: [] }]),
    { maxTags: 1 },
  );
  assert.equal(first.completion, "tag_budget");
  assert.deepEqual(first.completedTagIds, [6]);
  assert.deepEqual(first.remainingTags.map((tag) => tag.id), [37, 50, 306]);
  const resumed = await discoverBubiletCity(
    flight(fixture),
    async () => JSON.stringify([{ slug: "later", sessions: [] }]),
    { completedTagIds: first.completedTagIds },
  );
  assert.equal(resumed.completion, "exhausted");
  assert.deepEqual(resumed.completedTagIds, [6, 37, 50, 306]);
});

test("one failed tag preserves other discovery and remains retryable", async () => {
  const result = await discoverBubiletCity(flight(fixture), async (url) => {
    const id = Number(url.split("/").at(-1));
    if (id === 37) throw new Error("http_503");
    if (id === 50) return "not json";
    return JSON.stringify([{ slug: `event-${id}`, sessions: [] }]);
  });
  assert.equal(result.completion, "failed_tags");
  assert.deepEqual(result.productions.map((item) => item.slug), ["event-306", "event-6"]);
  assert.deepEqual(result.completedTagIds, [6, 306]);
  assert.deepEqual(result.failedTags.map((tag) => tag.id), [37, 50]);
  assert.deepEqual(result.remainingTags.map((tag) => tag.id), [37, 50]);
});

test("detail inventory distinguishes complete embedded sessions from calendar backlog", () => {
  const complete = bubiletDetailInventory(
    flight({
      eventId: 10,
      eventSlug: "workshop",
      cityId: 34,
      calendarBased: false,
      eventSessions: [{ sessionId: 1, date: "2026-10-01T10:00:00+03:00" }],
      allSessions: [],
    }),
    "workshop",
  );
  assert.equal(complete.coverage, "complete_embedded_inventory");
  const calendar = bubiletDetailInventory(
    flight({
      eventId: 11,
      eventSlug: "calendar-pass",
      cityId: 34,
      calendarBased: true,
      eventSessions: [{ sessionId: 2, date: "2026-10-02T10:00:00+03:00" }],
    }),
    "calendar-pass",
  );
  assert.equal(calendar.coverage, "calendar_ui_inventory_unverified");
});

test("sports detail shape is complete only when summary and ticket session ids agree", () => {
  const $ = flight([
    {
      slug: "basketball",
      sessions: [
        { id: 10, cityId: 34 },
        { id: 11, cityId: 34 },
      ],
    },
    {
      eventId: 12,
      eventSlug: "basketball",
      cityId: 34,
      eventSessions: [
        { sessionId: 10, cityId: 34 },
        { sessionId: 11, cityId: 34 },
      ],
    },
  ]);
  assert.equal(
    bubiletDetailInventory($, "basketball").coverage,
    "complete_embedded_inventory",
  );
});

test("calendar UI inventory is complete only when the public refresh API confirms exact ids", async () => {
  const $ = flight({
    eventId: 22005,
    eventSlug: "seramik",
    cityId: 34,
    calendarBased: true,
    eventSessions: [{ sessionId: 283820, cityId: 34, price: 1500 }],
  });
  const verified = await verifiedBubiletDetailInventory($, "seramik", async (url) => {
    assert.equal(
      url,
      "https://platform.api.bubilet.com.tr/v2/event/22005/city/34/sessions",
    );
    return JSON.stringify({
      sessions: [{ sessionId: 283820, cityId: 34, price: 1500 }],
      queue: null,
    });
  });
  assert.equal(verified.coverage, "complete_api_verified_inventory");
  await assert.rejects(
    verifiedBubiletDetailInventory($, "seramik", async () =>
      JSON.stringify({ sessions: [{ sessionId: 999, cityId: 34 }] }),
    ),
    /bubilet_session_inventory_mismatch/,
  );
});
