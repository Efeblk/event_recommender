import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { auditIdentityPairs } from "../identity/audit.ts";
import { resolveEventRecordIdentity, resolveIdentity } from "../identity/index.ts";
import { normalizeIdentityText } from "../normalize/identity.ts";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/identity-pairs.v1.json", import.meta.url), "utf8"),
);
const snapshot = JSON.parse(
  await readFile(new URL("../../web/data/events.json", import.meta.url), "utf8"),
);

function listing(overrides = {}) {
  return {
    listingId: "a",
    provider: "biletix",
    providerSessionIds: ["a"],
    url: "https://example/a",
    title: "Ortak Oyun",
    description: "",
    category: "Tiyatro",
    startsAt: "2026-10-02T17:00:00.000Z",
    city: "İstanbul",
    venue: { name: "Örnek Sahne", district: "Kadıköy" },
    ...overrides,
  };
}

test("identity text normalization stays exact for repeated mixed and oversized input", () => {
  const examples = [
    ["İSTANBUL’da MIXED English-Türkçe  ÇAĞRI!", "istanbul da mixed english turkce cagri"],
    ["  Stand-Up / WORKSHOP: Özel Gece  ", "stand up workshop ozel gece"],
    [null, ""],
    [undefined, ""],
  ];
  for (const [input, expected] of examples) {
    assert.equal(normalizeIdentityText(input), expected);
    assert.equal(normalizeIdentityText(input), expected);
  }
  const oversized = `${"İŞĞÜÖÇ English ".repeat(300)}SON`;
  const normalized = normalizeIdentityText(oversized);
  assert.equal(normalized.endsWith("son"), true);
  assert.equal(normalizeIdentityText(oversized), normalized);
});

test('Phase 1 reviewed aliases merge only under the existing session and venue guards', () => {
  const pairs = [
    ["Tanış - Konuş - Dans Et - (Sosyal Buluşma Etkinliği)", "Tanış • Konuş • Paylaş • Dans Et", "Rossi Suadiye", "Diğer"],
    ["Bir İshak'sın Bir Cemil Oyunu", "Bir İshaksın Bir Cemil", "Bakırköy Butik Sahne", "Tiyatro"],
    ["DJ Can Giray - Geçmişten Günümüze 90lar 2000ler Türkçe Pop", "Geçmişten Günümüze 90'lar 2000'ler Türkçe Pop", "Hayal Kahvesi Emaar", "Konser"],
    ["Discman 90’lar & 2000’ler Türkçe Pop Gecesi", "Discman 90lar & 2000ler Türkçe Pop", "Ayı Pub & Disko Rıhtım", "Konser"],
  ];
  for (const [left, right, venue, category] of pairs) {
    const a = listing({ title: left, category, venue: { name: venue, district: 'Kadıköy' } });
    const b = listing({ listingId: 'b', provider: 'bubilet', providerSessionIds: ['b'], url: 'https://example/b', title: right, category, venue: { ...a.venue, name: left.startsWith('Discman') ? 'Ayı Pub & Disko Rıhtım Kadıköy' : venue } });
    assert.equal(resolveIdentity([a, b]).sessions.length, 1, left);
    assert.equal(resolveIdentity([a, { ...b, startsAt: '2026-10-03T17:00:00.000Z' }]).sessions.length, 2);
    assert.equal(resolveIdentity([a, { ...b, venue: { name: 'Different venue', district: 'Şişli' } }]).sessions.length, 2);
    assert.equal(resolveIdentity([{ ...a, description: 'Sadece çocuklar için' }, { ...b, description: 'Sadece yetişkinler için' }]).sessions.length, 2);
  }
  const museum = listing({ title: 'İstanbul Diyalog Müzesi Sessizlik Deneyimi', category: 'Müze' });
  assert.equal(resolveIdentity([museum, { ...museum, listingId: 'b', provider: 'bubilet', providerSessionIds: ['b'], title: 'İstanbul Diyalog Müzesi Karanlık Deneyimi' }]).sessions.length, 2);
});

test("frozen held-out pairs have zero wrong and missed merges", () => {
  const report = auditIdentityPairs(fixture, "heldout");
  assert.equal(report.wrongMerges, 0);
  assert.equal(report.missedMerges, 0);
  assert.equal(report.deterministicRecall, 1);
  assert.deepEqual(
    new Set(report.expectedFamilies),
    new Set([
      "suffix-only",
      "spelling-only",
      "both",
      "Bakırköy Butik vs BBS Yenibosna",
      "Cem Adrian JJ Arena vs Yahya Kemal Beyatlı",
    ]),
  );
  for (const result of report.results.filter(
    ({ expectedFamily }) => expectedFamily === "suffix-only",
  ))
    assert.equal(result.rule, "same-venue-suffix-normalized-title");
  for (const result of report.results.filter(({ expectedFamily }) =>
    ["suffix-only", "spelling-only"].includes(expectedFamily),
  )) {
    assert.equal(result.rule, "same-venue-suffix-normalized-title");
    assert.ok(result.venueEvidence.every((evidence) => !evidence.startsWith("manual-venue-seed:")));
  }
  assert.equal(
    report.results.find(
      ({ expectedFamily }) => expectedFamily === "Bakırköy Butik vs BBS Yenibosna",
    ).rule,
    "different-resolved-venue",
  );
});

test("every labelled ID and unmodified source field exists in the frozen snapshot", () => {
  const byId = new Map(snapshot.map((record) => [record.id, record]));
  for (const pair of [...fixture.train, ...fixture.heldout])
    for (const labelled of [pair.left, pair.right]) {
      const source = byId.get(labelled.id);
      assert.ok(source, `${pair.label}: ${labelled.id}`);
      assert.equal(source.source, labelled.provider, `${pair.label}: provider`);
      assert.equal(source.title, labelled.title, `${pair.label}: title`);
      assert.equal(source.startsAt, labelled.startsAt, `${pair.label}: startsAt`);
      assert.equal(source.venue, labelled.venue, `${pair.label}: venue`);
      assert.equal(source.category, labelled.category, `${pair.label}: category`);
    }
});

test(
  "full 4k-record frozen snapshot avoids a global quadratic venue scan",
  { timeout: 60_000 },
  () => {
    assert.ok(snapshot.length > 4_000);
    const started = performance.now();
    const result = resolveIdentity(
      snapshot.map((record) => ({
        listingId: record.id,
        provider: record.source ?? "legacy-unknown",
        providerSessionIds: record.sourceSessionIds ?? [],
        url: record.url,
        title: record.title,
        description: record.description,
        category: record.category,
        startsAt: record.startsAt,
        city: record.city,
        venue: { name: record.venue, district: record.district, address: record.address },
      })),
    );
    const elapsed = performance.now() - started;
    assert.ok(result.sessions.length > 3_000);
    assert.ok(elapsed < 60_000, `identity resolution took ${Math.round(elapsed)}ms`);
  },
);

test("geo proximity requires meaningful venue-name overlap", () => {
  const near = { lat: 41.001, lon: 29.001 };
  const records = [
    listing({ listingId: "a", venue: { name: "JJ Arena", district: "Ataşehir", geo: near } }),
    listing({
      listingId: "b",
      provider: "bubilet",
      venue: {
        name: "Yahya Kemal Beyatlı Gösteri Merkezi",
        district: "Ataşehir",
        geo: { lat: 41.0011, lon: 29.0011 },
      },
    }),
  ];
  const result = resolveIdentity(records);
  assert.equal(result.venues.length, 2);
  assert.equal(result.sessions.length, 2);
});

test("geo proximity with a meaningful name token resolves one venue", () => {
  const records = [
    listing({
      listingId: "a",
      venue: { name: "Zorlu PSM Turkcell Sahnesi", geo: { lat: 41.067, lon: 29.017 } },
    }),
    listing({
      listingId: "b",
      provider: "bubilet",
      venue: { name: "Turkcell Sahnesi", geo: { lat: 41.0671, lon: 29.0171 } },
    }),
  ];
  const result = resolveIdentity(records);
  assert.equal(result.venues.length, 1);
  assert.equal(result.sessions.length, 1);
});

test("venue components retain non-first provider and geo conflict signatures", () => {
  const providerRecords = [
    listing({
      listingId: "provider-a-1",
      providerSessionIds: ["provider-a-1"],
      venue: { name: "Ortak Sahne", district: "Kadıköy", providerVenueId: "venue-a" },
    }),
    listing({
      listingId: "neutral",
      provider: "bubilet",
      providerSessionIds: ["neutral"],
      venue: { name: "Ortak Sahne", district: "Kadıköy" },
    }),
    listing({
      listingId: "provider-a-2",
      providerSessionIds: ["provider-a-2"],
      venue: { name: "Ortak Sahne", district: "Kadıköy", providerVenueId: "venue-a" },
    }),
    listing({
      listingId: "provider-b",
      providerSessionIds: ["provider-b"],
      venue: { name: "Ortak Sahne", district: "Kadıköy", providerVenueId: "venue-b" },
    }),
  ];
  assert.equal(resolveIdentity(providerRecords).venues.length, 2);
  assert.equal(resolveIdentity([...providerRecords].reverse()).venues.length, 2);

  const near = { lat: 41.001, lon: 29.001 };
  const geoRecords = [
    listing({
      listingId: "geo-near-1",
      providerSessionIds: ["geo-near-1"],
      venue: { name: "Ortak Sahne", district: "Kadıköy", geo: near },
    }),
    listing({
      listingId: "geo-neutral",
      provider: "bubilet",
      providerSessionIds: ["geo-neutral"],
      venue: { name: "Ortak Sahne", district: "Kadıköy" },
    }),
    listing({
      listingId: "geo-near-2",
      provider: "bubilet",
      providerSessionIds: ["geo-near-2"],
      venue: { name: "Ortak Sahne", district: "Kadıköy", geo: near },
    }),
    listing({
      listingId: "geo-far",
      provider: "bubilet",
      providerSessionIds: ["geo-far"],
      venue: {
        name: "Ortak Sahne",
        district: "Kadıköy",
        geo: { lat: 41.101, lon: 29.101 },
      },
    }),
  ];
  assert.equal(resolveIdentity(geoRecords).venues.length, 2);
  assert.equal(resolveIdentity([...geoRecords].reverse()).venues.length, 2);
});

test("non-finite coordinates are removed before venue conflict comparisons", () => {
  const records = [
    listing({
      listingId: "geo-nan",
      venue: { name: "Ortak Sahne", providerVenueId: "shared", geo: { lat: 41, lon: NaN } },
    }),
    listing({
      listingId: "geo-infinity",
      venue: {
        name: "Ortak Sahne",
        providerVenueId: "shared",
        geo: { lat: 41, lon: Infinity },
      },
    }),
    listing({
      listingId: "geo-finite",
      venue: {
        name: "Ortak Sahne",
        providerVenueId: "shared",
        geo: { lat: 41, lon: 29 },
      },
    }),
  ];
  const result = resolveIdentity(records);
  const reversed = resolveIdentity([...records].reverse());
  const sanitized = resolveIdentity(
    records.map((record) =>
      Number.isFinite(record.venue.geo?.lat) && Number.isFinite(record.venue.geo?.lon)
        ? record
        : { ...record, venue: { ...record.venue, geo: undefined } },
    ),
  );

  assert.equal(result.venues.length, 1);
  assert.deepEqual(result, reversed);
  assert.deepEqual(result, sanitized);
});

test("identical names join unless their stated locations conflict", () => {
  const venues = (...entries) =>
    resolveIdentity(
      entries.map((venue, index) =>
        listing({ listingId: `v${index}`, provider: `p${index}`, venue }),
      ),
    ).venues.length;
  // Missing and side-only districts are not conflicts (Corner Kadıköy).
  assert.equal(
    venues(
      { name: "Corner Kadıköy", district: "İstanbul Anadolu" },
      { name: "Corner Kadıköy", address: "Caferağa, Misbah Muhayyeş Sok. No:5 Kadıköy/İstanbul" },
      { name: "Corner Kadıköy", district: "KADIKÖY" },
    ),
    1,
  );
  assert.equal(venues({ name: "Ortak İsim" }, { name: "Ortak İsim" }), 1);
  assert.equal(
    venues({ name: "Ortak İsim", district: "Kadıköy" }, { name: "Ortak İsim", district: "Beşiktaş" }),
    2,
  );
  assert.equal(
    venues(
      { name: "Ortak İsim", district: "İstanbul Anadolu" },
      { name: "Ortak İsim", district: "İstanbul Avrupa" },
    ),
    2,
  );
});

test("neighbourhoods map to districts and one wrong field cannot veto a match", () => {
  const venues = (...entries) =>
    resolveIdentity(
      entries.map((venue, index) =>
        listing({ listingId: `v${index}`, provider: `p${index}`, venue }),
      ),
    ).venues.length;
  assert.equal(
    venues(
      { name: "Trump Sahne", district: "MECİDİYEKÖY" },
      { name: "Trump Sahne", address: "Kuştepe, Kuştepe Trump Alışveriş Merkezi, 34387 Şişli/İstanbul" },
    ),
    1,
  );
  // Biletix lists this Kadıköy bar under Beyoğlu; the name and the other
  // provider's address still agree on Kadıköy.
  assert.equal(
    venues(
      { name: "Ada Bar Kadıköy", district: "BEYOĞLU" },
      { name: "Ada Bar Kadıköy", address: "Caferağa Mah. Kadıköy/İstanbul" },
    ),
    1,
  );
  // The address's final district wins over a street named after another one.
  assert.equal(
    venues(
      { name: "Örnek Salon", district: "Büyükçekmece" },
      { name: "Örnek Salon", address: "Fatih Mah. Atatürk Cad. No:3 Büyükçekmece/İstanbul" },
    ),
    1,
  );
});

test("descriptor and spelling variants join; hall-only or ambiguous names do not", () => {
  const venueGroups = (...names) => {
    const result = resolveIdentity(
      names.map((name, index) =>
        listing({ listingId: `v${index}`, provider: `p${index}`, venue: { name } }),
      ),
    );
    return result.venues.map((venue) => venue.listingIds.map((id) => names[Number(id.slice(1))]).sort());
  };
  for (const pair of [
    ["Harbiye Cemil Topuzlu Açıkhava Sahnesi", "Harbiye Cemil Topuzlu Açıkhava Tiyatrosu"],
    ["Evde Tiyatro", "Evde Tiyatro (Caddebostan)"],
    ["BBS Sahne", "B-B-S SAHNE YENİBOSNA"],
    ["Dream Park İstanbul", "Dreampark İstanbul"],
    ["Karga Bar Kadıköy", "Karga Kadıköy"],
    ["Beylikdüzü Atatürk Kültür ve Sanat Merkezi", "Beylikdüzü Atatürk Kültür ve Sanat Merkezi (BAKSM)"],
  ])
    assert.equal(venueGroups(...pair).length, 1, pair.join(" ~ "));
  for (const pair of [
    ["Moda Sahnesi Büyük Salon", "Caddebostan Kültür Merkezi Büyük Salon"],
    ["Evde Tiyatro", "Cafe Theatre Koşuyolu"],
    ["Bakırköy Butik Sahne", "B-B-S SAHNE YENİBOSNA"],
    ["Trump Sahne", "Ada Roof Trump AVM"],
  ])
    assert.equal(venueGroups(...pair).length, 2, pair.join(" ~ "));
  // "Turkcell Sahnesi" could extend to either hall; it joins neither.
  const halls = venueGroups(
    "Turkcell Sahnesi",
    "Zorlu PSM Turkcell Sahnesi",
    "Zorlu PSM Turkcell Platinum Sahnesi",
  );
  assert.ok(
    halls.every((group) => !(group.includes("Zorlu PSM Turkcell Sahnesi") && group.includes("Zorlu PSM Turkcell Platinum Sahnesi"))),
  );
  assert.ok(halls.some((group) => group.length === 1 && group[0] === "Turkcell Sahnesi"));
});

test("reviewed workshop aliases require their venue evidence guards", () => {
  const address = "Aziz Mahmut Hüdayi, Gülfem Sk. No:15, 34672 Üsküdar/İstanbul";
  const named = listing({
    listingId: "a",
    category: "Workshop",
    title: "Tezhip Atölyesi",
    venue: { name: "Fabrikafa Make & Coffee", district: "Üsküdar" },
  });
  const generic = listing({
    listingId: "b",
    provider: "bubilet",
    category: "Workshop",
    title: "İstanbul Workshops Tezhip Atölyesi",
    venue: { name: "İstanbul Workshops", address },
  });
  const accepted = resolveIdentity([named, generic]);
  assert.equal(accepted.sessions.length, 1);
  assert.equal(accepted.decisions[0].outcome, "manual_merge");
  const rejected = resolveIdentity([
    named,
    { ...generic, listingId: "c", venue: { name: "İstanbul Workshops" } },
  ]);
  assert.equal(rejected.sessions.length, 2);
});

test("audience, workshop/performance, and adaptation conflicts are mandatory failures", () => {
  const pairs = [
    [
      listing({ listingId: "a1", description: "Sadece çocuklar için." }),
      listing({
        listingId: "b1",
        provider: "bubilet",
        description: "Yalnızca yetişkinler için 18+.",
      }),
    ],
    [
      listing({
        listingId: "a2",
        category: "Workshop",
        description: "Uygulamalı bir atölye çalışması.",
      }),
      listing({
        listingId: "b2",
        provider: "bubilet",
        category: "Tiyatro",
        description: "Canlı sahne gösterisidir.",
      }),
    ],
    [
      listing({ listingId: "a3", description: "Uyarlama: Yazar A" }),
      listing({ listingId: "b3", provider: "bubilet", description: "Uyarlama: Yazar B" }),
    ],
    [
      listing({ listingId: "a4", description: "18 yaş altı giremez." }),
      listing({
        listingId: "b4",
        provider: "bubilet",
        description: "Sadece çocuklar için.",
      }),
    ],
  ];
  for (const records of pairs) {
    const result = resolveIdentity(records);
    assert.equal(result.sessions.length, 2);
    assert.equal(result.decisions[0].outcome, "never_merge");
    assert.equal(result.decisions[0].rule, "policy-conflict");
  }
});

const timedSession = {
  kind: "timed_session",
  evidence: "provider_sessions_and_source_text",
};
const admissionWindow = (validFrom, validThrough) => ({
  kind: "admission_window",
  evidence: "provider_flexible_window",
  validFrom,
  validThrough,
});
const unknownTiming = {
  kind: "unknown",
  evidence: "insufficient_source_evidence",
};

test("known attendance kinds and distinct admission windows never merge", () => {
  const firstWindow = admissionWindow("2026-10-02T08:00:00.000Z", "2026-10-02T16:00:00.000Z");
  const secondWindow = admissionWindow("2026-10-02T09:00:00.000Z", "2026-10-02T17:00:00.000Z");
  for (const [leftTiming, rightTiming] of [
    [timedSession, firstWindow],
    [firstWindow, secondWindow],
  ]) {
    const result = resolveIdentity([
      listing({ listingId: "timing-a", attendanceTiming: leftTiming }),
      listing({
        listingId: "timing-b",
        provider: "bubilet",
        attendanceTiming: rightTiming,
      }),
    ]);
    assert.equal(result.sessions.length, 2);
    assert.equal(result.decisions[0].outcome, "never_merge");
    assert.equal(result.decisions[0].rule, "attendance-timing-conflict");
  }
});

test("absent, JSON null, and explicit unknown attendance remain neutral", () => {
  const records = [
    listing({ listingId: "timing-absent" }),
    listing({
      listingId: "timing-null",
      provider: "bubilet",
      attendanceTiming: null,
    }),
    listing({
      listingId: "timing-unknown",
      provider: "biletinial",
      attendanceTiming: unknownTiming,
    }),
  ];
  const result = resolveIdentity(records);
  assert.equal(result.sessions.length, 1);
  assert.ok(result.decisions.every(({ outcome }) => outcome === "auto_merge"));

  const nullDecision = resolveIdentity(records.slice(0, 2)).decisions[0];
  const unknownDecision = resolveIdentity([
    records[0],
    { ...records[1], attendanceTiming: unknownTiming },
  ]).decisions[0];
  assert.equal(nullDecision.inputHash, unknownDecision.inputHash);
});

test("reviewed aliases and the EventRecord adapter cannot bypass attendance conflicts", () => {
  const address = "Aziz Mahmut Hüdayi, Gülfem Sk. No:15, 34672 Üsküdar/İstanbul";
  const records = [
    listing({
      listingId: "workshop-a",
      category: "Workshop",
      title: "Tezhip Atölyesi",
      attendanceTiming: timedSession,
      venue: { name: "Fabrikafa Make & Coffee", district: "Üsküdar" },
    }),
    listing({
      listingId: "workshop-b",
      provider: "bubilet",
      category: "Workshop",
      title: "İstanbul Workshops Tezhip Atölyesi",
      attendanceTiming: admissionWindow("2026-10-02T08:00:00.000Z", "2026-10-02T16:00:00.000Z"),
      venue: { name: "İstanbul Workshops", address },
    }),
  ];
  const direct = resolveIdentity(records);
  assert.equal(direct.sessions.length, 2);
  assert.equal(direct.decisions[0].rule, "attendance-timing-conflict");

  const adapted = resolveEventRecordIdentity(
    records.map((record) => ({
      id: record.listingId,
      source: record.provider,
      sourceSessionIds: record.providerSessionIds,
      url: record.url,
      title: record.title,
      description: record.description,
      category: record.category,
      startsAt: record.startsAt,
      attendanceTiming: record.attendanceTiming,
      venue: record.venue.name,
      city: record.city,
      district: record.venue.district ?? "",
      address: record.venue.address ?? "",
    })),
  );
  assert.equal(adapted.sessions.length, 2);
  assert.equal(adapted.decisions[0].rule, "attendance-timing-conflict");
});

test("graph transitivity never produces two listings from one provider", () => {
  const records = [
    listing({ listingId: "a", provider: "biletix" }),
    listing({ listingId: "b", provider: "bubilet", url: "https://example/b" }),
    listing({ listingId: "c", provider: "biletix", url: "https://example/c" }),
  ];
  const result = resolveIdentity(records);
  assert.equal(result.sessions.length, 2);
  for (const session of result.sessions) {
    const providers = session.listingIds.map(
      (id) => records.find((record) => record.listingId === id).provider,
    );
    assert.equal(new Set(providers).size, providers.length);
  }
  assert.ok(
    result.decisions.some(
      ({ rule }) => rule === "same-provider" || rule === "graph-same-provider-collision",
    ),
  );
});

test("venue and session IDs do not churn when another provider joins a stable compact venue", () => {
  const first = listing({ listingId: "a" });
  const second = listing({ listingId: "b", provider: "bubilet", url: "https://example/b" });
  const before = resolveIdentity([first]);
  const after = resolveIdentity([first, second]);
  assert.equal(before.venues[0].id, after.venues[0].id);
  assert.equal(before.sessions[0].id, after.sessions[0].id);
});

test("disconnected same-name venue components never collide", () => {
  const records = [
    listing({
      listingId: "far-a",
      venue: {
        name: "Ortak Sahne",
        district: "Kadıköy",
        geo: { lat: 40.9901, lon: 29.0201 },
      },
    }),
    listing({
      listingId: "far-b",
      provider: "bubilet",
      venue: {
        name: "Ortak Sahne",
        district: "Kadıköy",
        geo: { lat: 40.9991, lon: 29.0291 },
      },
    }),
  ];
  const result = resolveIdentity(records);
  assert.equal(result.venues.length, 2);
  assert.equal(new Set(result.venues.map(({ id }) => id)).size, 2);
  assert.equal(result.sessions.length, 2);
});

test("identity decisions retain stable review evidence", () => {
  const result = resolveIdentity([
    listing({ listingId: "a", title: "Örnek Oyun" }),
    listing({ listingId: "b", provider: "bubilet", title: "Örnek Oyun Tiyatro Oyunu" }),
  ]);
  assert.equal(result.decisions[0].outcome, "auto_merge");
  assert.match(result.decisions[0].inputHash, /^[a-f0-9]{64}$/);
  assert.match(result.decisions[0].ruleVersion, /^deterministic-identity\.v5/);
  assert.ok(result.decisions[0].evidence.length > 0);
});

test("placeholder coordinates are unknown and mall-scale geocode drift is not a conflict", () => {
  const sessions = (...venues) =>
    resolveIdentity(
      venues.map((venue, index) =>
        listing({ listingId: `g${index}`, provider: `p${index}`, venue }),
      ),
    ).sessions.length;
  // Biletinial sends 0,0 when it has no location (Corner Kadıköy, Sahne Dragos).
  assert.equal(
    sessions(
      { name: "Corner Kadıköy", geo: { lat: 0, lon: 0 } },
      { name: "Corner Kadıköy", geo: { lat: 40.98912, lon: 29.0226 } },
    ),
    1,
  );
  // Providers geocode Torium AVM about 500 m apart.
  assert.equal(
    sessions(
      { name: "Torium Sahne", geo: { lat: 41.00487, lon: 28.6894 } },
      { name: "Torium Sahne", geo: { lat: 41.00903, lon: 28.6888 } },
    ),
    1,
  );
});

test("an exact name match outranks a shared-word geo match into a neighbouring venue", () => {
  const records = [
    listing({ listingId: "a", provider: "biletix", venue: { name: "Habitat Hilltown", providerVenueId: "H1" } }),
    listing({
      listingId: "b",
      provider: "bubilet",
      venue: { name: "HABITAT Hilltown", geo: { lat: 40.95272, lon: 29.12201 } },
    }),
    listing({
      listingId: "c",
      provider: "biletix",
      title: "Başka Oyun",
      venue: { name: "Hilltown Seyirlik Sahne", providerVenueId: "H2", geo: { lat: 40.95275, lon: 29.12205 } },
    }),
  ];
  const { listingVenueIds } = resolveIdentity(records);
  assert.equal(listingVenueIds.a, listingVenueIds.b);
  assert.notEqual(listingVenueIds.a, listingVenueIds.c);
});

test("a title prefixed with its own venue name matches; other prefixes do not", () => {
  const merged = (left, right) =>
    resolveIdentity([
      listing({ listingId: "l", provider: "biletix", ...left }),
      listing({ listingId: "r", provider: "bubilet", ...right }),
    ]).sessions.length === 1;
  assert.equal(
    merged(
      { title: "HABITAT X Evgeny Grinko", category: "Konser", venue: { name: "Habitat Hilltown" } },
      { title: "Evgeny Grinko", category: "Konser", venue: { name: "Habitat Hilltown" } },
    ),
    true,
  );
  assert.equal(
    merged(
      { title: "Anka Workshop: Mum Atölyesi", category: "Workshop", venue: { name: "Ankaworkshop" } },
      { title: "Mum Atölyesi", category: "Workshop", venue: { name: "Ankaworkshop" } },
    ),
    true,
  );
  assert.equal(
    merged(
      { title: "Mozaik Workshop: Sosyal Sanathane", category: "Workshop", venue: { name: "Sosyal Sanathane" } },
      { title: "Workshop: Sosyal Sanathane", category: "Workshop", venue: { name: "Sosyal Sanathane" } },
    ),
    false,
  );
});

test("identical titles match even when providers disagree on category", () => {
  const result = resolveIdentity([
    listing({ listingId: "l", provider: "biletix", title: "Alpay Erdem Stand Up", category: "Stand-up" }),
    listing({ listingId: "r", provider: "biletinial", title: "Alpay Erdem Stand Up", category: "Tiyatro" }),
  ]);
  assert.equal(result.sessions.length, 1);
});

test("provider category and uncredited prose are not format or adaptation evidence", () => {
  // Biletix files the Kasımpaşa Semazen ceremony as Workshop; others as Konser.
  const ceremony = resolveIdentity([
    listing({ listingId: "a", title: "Semazen Töreni", category: "Workshop" }),
    listing({ listingId: "b", provider: "bubilet", title: "Semazen Töreni", category: "Konser" }),
  ]);
  assert.equal(ceremony.sessions.length, 1);
  // The same production description quoted with different lengths.
  const play = resolveIdentity([
    listing({
      listingId: "c",
      description: "Romandan sahneye uyarlama olarak izleyici ile buluşuyor; Serdar Biliş'in yönetmenliğinde.",
    }),
    listing({
      listingId: "d",
      provider: "bubilet",
      description: "Romandan sahneye uyarlama olarak izleyici ile buluşuyor. Hayri İrdal çocukluğunu anlatıyor.",
    }),
  ]);
  assert.equal(play.sessions.length, 1);
});

test("performer or series parts around a show title merge; exact pairs keep precedence", () => {
  const venue = { name: "Cafe Theatre Koşuyolu", district: "Kadıköy" };
  const sessions = (...titles) =>
    resolveIdentity(titles.map(([provider, title], index) => listing({ listingId: `t${index}`, provider, title, venue }))).sessions;
  assert.equal(sessions(["biletix", "Bir Delinin Hatıra Defteri"], ["bubilet", "Bir Delinin Hatıra Defteri - Metin Zakoğlu"]).length, 1);
  assert.equal(
    sessions(
      ["biletix", "Bir Delinin Hatıra Defteri"],
      ["bubilet", "Bir Delinin Hatıra Defteri - Metin Zakoğlu"],
      ["biletinial", "Bir Delinin Hatıra Defteri Metin Zakoğlu"],
    ).length,
    1,
  );
  // A generic listing page title names no show and never joins a specific one.
  const generic = resolveIdentity([
    listing({ listingId: "g1", provider: "biletinial", title: "3D Figür Boyama Workshop: Sosyal Sanathane", category: "Workshop", venue: { name: "Sosyal Sanathane" } }),
    listing({ listingId: "g2", provider: "bubilet", title: "3D Figür Boyama Workshop: Sosyal Sanathane", category: "Workshop", venue: { name: "Sosyal Sanathane" } }),
    listing({ listingId: "g3", provider: "bubilet", title: "Workshop: Sosyal Sanathane", category: "Workshop", venue: { name: "Sosyal Sanathane" } }),
  ]);
  const together = generic.sessions.find((s) => s.listingIds.includes("g1"));
  assert.deepEqual(together.listingIds, ["g1", "g2"]);
});

test("İnfiniti Sahne open-mic titles merge per session and stay apart from Bi Şaka", () => {
  const venue = { name: "İnfiniti Sahne", district: "Beyoğlu" };
  const at = (listingId, provider, title, startsAt = "2026-10-07T17:30:00.000Z") =>
    listing({ listingId, provider, providerSessionIds: [listingId], url: `https://example/${listingId}`, title, category: "Stand-up", startsAt, venue });
  const wednesday = [
    at("x1", "biletix", "Stand Up Açık Mikrofon Beyoğlu Çarşamba"),
    at("u1", "bubilet", "Stand Up Taksim Gecesi & Açık Mikrofon Çarşamba"),
    at("n1", "biletinial", "Stand up Açık Mikrofon Beyoğlu | İnfiniti Sahne"),
    at("x2", "biletix", "Bi Şaka Stand Up"),
    at("u2", "bubilet", "Bi Şaka Stand up Programı"),
    at("n2", "biletinial", "Bi Şaka Stand up Programı"),
  ];
  const sessions = resolveIdentity(wednesday).sessions.map((s) => [...s.listingIds].sort().join(","));
  assert.deepEqual(sessions.sort(), ["n1,u1,x1", "n2,u2,x2"]);
  const thursday = "2026-10-08T17:30:00.000Z";
  const split = resolveIdentity([at("x1", "biletix", "Stand Up Açık Mikrofon Beyoğlu Çarşamba"), at("u3", "bubilet", "Stand Up Taksim Gecesi & Açık Mikrofon Perşembe", thursday)]);
  assert.equal(split.sessions.length, 2);
});
