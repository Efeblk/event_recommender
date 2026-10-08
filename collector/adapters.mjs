import { createHash } from "node:crypto";
import { jsonLd, parseEvents } from "../contracts/source.ts";
import { categoryFromSource, categoryForEvent } from "../contracts/category.ts";
import {
  biletixAttendanceTiming,
  hasExplicitDoorTimeStartConflict,
} from "../contracts/timing.ts";
import { discoverBiletinialCategories, extractBiletinial } from './biletinial.mjs';
import { verifiedBubiletDetailInventory } from './bubilet.mjs';

// Biletix minPrice is an integer minor-unit value. Requiring a safe integer
// preserves the same safe-cent bound used by collector and import validation.
const MAX_BILETIX_MINOR_PRICE = Number.MAX_SAFE_INTEGER;

export const sources = {
  biletinial: {
    origin: "https://biletinial.com",
    paths: [
      ["/tr-tr/muzik/istanbul", "Konser"],
      ["/tr-tr/tiyatro/istanbul", "Tiyatro"],
      ["/tr-tr/etkinlikleri/stand-up", "Stand-up"],
    ],
    detail: /^\/tr-tr\/(muzik|tiyatro|gosteri|etkinlik|sinema|futbol|spor|opera-bale|egitim|seminer|eglence)\/[^/]+$/,
  },
  bubilet: {
    origin: "https://www.bubilet.com.tr",
    paths: [["/istanbul", null]],
    detail: /^\/istanbul\/etkinlik\/[^/]+$/,
  },
  biletix: {
    origin: "https://www.biletix.com",
    paths: [["/search/ISTANBUL/tr", null]],
    detail: /^\/etkinlik\/([A-Z0-9]+)\/ISTANBUL\/tr(?:\/[^/]+)?$/,
  },
};
export async function resolveListings(source, get) {
  if (source !== 'biletinial') return sources[source].paths;
  // The public header's Turkish/Turkey request includes these source-rendered IDs.
  const entries = discoverBiletinialCategories(await get('https://biletinial.com/tr-tr/Menu/HeaderMenu?langId=1&countryId=3'));
  if (!entries.length) throw new Error('source_taxonomy_missing');
  return entries.map(({path,istanbulPath,category}) => [path.includes('/etkinlikleri/') ? path : istanbulPath, category]);
}
export function detailUrl(raw, source) {
  try {
    const url = new URL(raw, sources[source].origin);
    if (
      url.origin !== sources[source].origin ||
      url.username ||
      url.password ||
      !sources[source].detail.test(url.pathname)
    )
      return null;
    // Biletix's trailing SEO title is mutable; event code is the stable URL identity.
    if (source === "biletix")
      return `${url.origin}/etkinlik/${url.pathname.split("/")[2]}/ISTANBUL/tr`;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}
export function discover($, source) {
  const urls = new Set();
  $("a[href]").each((_index, element) => {
    const url = detailUrl($(element).attr("href"), source);
    if (url) urls.add(url);
  });
  for (const node of jsonLd($.html())) {
    for (const item of node.itemListElement ?? []) {
      const url = detailUrl(item?.url ?? item?.item?.url ?? item?.item, source);
      if (url) urls.add(url);
    }
  }
  return [...urls];
}
const clean = (value) =>
  typeof value === "string"
    ? value
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

function categoryOf(text) {
  return categoryFromSource(text);
}
export function categorySupportedByEvent(category, title, description) {
  return categoryForEvent(category ?? '', clean(title), clean(description));
}
function checkedSourceTimes(events) {
  if (
    events.some((event) =>
      hasExplicitDoorTimeStartConflict({
        description: event.description,
        startsAt: event.startsAt,
      }),
    )
  )
    throw new Error("session_time_conflict");
  return events;
}
export async function extract($, source, url, fallbackCategory, now = new Date(), options = {}) {
  const html = $.html();
  if (source === "biletix") return checkedSourceTimes(extractBiletix($, url, now));
  if (source === "biletinial")
    return checkedSourceTimes(
      await extractBiletinial($, url, fallbackCategory, now, {
        ...options,
        categoryForEvent,
      }),
    );
  const nodes = jsonLd(html);
  const eventNodes = nodes.filter((node) =>
    [node["@type"]].flat().some((t) => typeof t === "string" && t.endsWith("Event")),
  );
  if (!eventNodes.length) throw new Error("schema_missing");
  let category = source === "biletinial" ? fallbackCategory : null;
  let sourceCategory = clean(fallbackCategory);
  if (source === "bubilet") {
    // Breadcrumbs run from broad navigation to the event. The deepest
    // recognized provider label is the closest source evidence for format.
    const eventTitle = clean(eventNodes.find((node) => typeof node.name === "string")?.name);
    const normalizedTitle = eventTitle.toLocaleLowerCase("tr-TR").replace(/[^a-z0-9çğıöşü]+/gi, " ").trim();
    const isCurrentEvent = (crumb) => {
      const raw = clean(crumb.name);
      if (raw.toLocaleLowerCase("tr-TR").replace(/[^a-z0-9çğıöşü]+/gi, " ").trim() === normalizedTitle)
        return true;
      const item = typeof crumb.item === "string" ? crumb.item : crumb.item?.url ?? crumb.item?.["@id"] ?? crumb.url;
      try {
        const candidate = new URL(item, url);
        const current = new URL(url);
        return candidate.origin === current.origin && candidate.pathname === current.pathname;
      } catch {
        return false;
      }
    };
    const crumbs = nodes
      .filter((n) => n["@type"] === "BreadcrumbList")
      .flatMap((n) => n.itemListElement ?? [])
      .map((crumb, index) => ({ crumb, index }))
      .sort((a, b) => {
        const left = Number(a.crumb.position), right = Number(b.crumb.position);
        return Number.isFinite(left) && Number.isFinite(right) ? left - right : a.index - b.index;
      })
      .map(({ crumb }) => crumb)
      .filter((crumb) => !isCurrentEvent(crumb));
    const matched = crumbs
      .map((crumb) => ({ raw: clean(crumb.name), category: categoryOf(clean(crumb.name)) }))
      .filter((crumb) => crumb.category)
      .at(-1);
    category = matched?.category ?? fallbackCategory;
    sourceCategory = matched?.raw ?? sourceCategory;
  }
  category ??= 'Diğer';
  if (source === "bubilet")
    return checkedSourceTimes(
      await extractBubilet(
        $,
        url,
        category,
        sourceCategory,
        nodes,
        now,
        options,
      ),
    );
  const events = await parseEvents(html, url, category, now);
  // An Event schema alone is insufficient evidence that a page is now empty.
  // Preserve old rows when a redesign drops essential fields or all rows are rejected.
  if (!events.length) throw new Error("no_verified_sessions");
  return checkedSourceTimes(events.map((event) => ({ ...event,
    category: categorySupportedByEvent(event.category, event.title, event.description),
    source, sourceCategory: category, sourceVersion: "4", extraction: "json-ld" })));
}
function extractBiletix($, url, now) {
  let state;
  try {
    state = JSON.parse($("#ng-state").text());
  } catch {
    throw new Error("schema_missing");
  }
  const code = url.split("/")[4];
  const responses = Object.values(state).filter(
    (entry) => entry?.b?.status === "SUCCESS" && typeof entry.u === "string",
  );
  const detail = responses
    .map((r) => r.b.data)
    .find((d) => d && !Array.isArray(d) && d.eventCode === code && d.eventName);
  const performances = responses.find((r) => r.u.includes(`/getPerformanceList/${code}/`))?.b?.data;
  if (!detail || !Array.isArray(performances) || !performances.length)
    throw new Error("schema_missing");
  const sourceLabel = clean(detail.subCategory || detail.eventCategoryCode);
  const parentCategory = categoryOf(clean(detail.eventCategoryCode));
  // Parent categories are provider format evidence. A music genre in
  // subCategory must not turn a sport, education or museum event into a concert.
  // Generic/unmapped parents may still use a specific subformat.
  const sourceCategory = parentCategory ?? categoryOf(sourceLabel);
  const policyParts = [detail.info, detail.eventRules]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => clean(value))
    .filter(Boolean);
  const description = [
    clean(detail.eventDescription).slice(0, 3500),
    policyParts.length ? `Etkinlik kuralları: ${policyParts.join(' ')}`.slice(0, 1500) : '',
  ].filter(Boolean).join(' ').slice(0, 5000);
  const category = categorySupportedByEvent(
    sourceCategory,
    detail.eventName,
    description,
  );
  if (!category) throw new Error("unsupported_category");
  const attendanceTiming = biletixAttendanceTiming({
    category,
    description,
    flexibleTimeEventCheck: detail.flexibleTimeEventCheck,
    startShowDate: detail.startShowDate,
    endShowDate: detail.endShowDate,
    performanceDates: performances.map((performance) => performance?.performanceDate),
  });
  const image = $('meta[property="og:image"]').attr("content") ?? "";
  const groups = new Map();
  for (const p of performances) {
    if (p.eventCode !== code || typeof p.performanceDate !== 'number' ||
        !Number.isFinite(p.performanceDate) || !clean(p.venueCity) || !clean(p.venueName))
      throw new Error('session_schema_changed');
    if (
      p.eventCode !== code ||
      p.venueCity !== "İstanbul" ||
      typeof p.performanceDate !== "number" ||
      !Number.isFinite(p.performanceDate) ||
      p.performanceDate < now.getTime() ||
      !clean(p.venueName)
    )
      continue;
    const key = `${p.performanceDate}|${clean(p.venueName)}`;
    const rows = groups.get(key) ?? [];
    rows.push(p);
    groups.set(key, rows);
  }
  const events = [];
  for (const rows of groups.values()) {
    const first = rows[0],
      startsAt = new Date(first.performanceDate).toISOString();
    const onSale = rows.filter((p) => p.active === true && p.status === "s01_onsale");
    // Biletix minPrice is integer kurus (verified against rendered 520,00 TL / 52000).
    const prices = onSale
      .map((p) => p.minPrice)
      .filter(
        (p) =>
          Number.isSafeInteger(p) && p >= 0 && p <= MAX_BILETIX_MINOR_PRICE,
      )
      .map((p) => p / 100);
    events.push({
      id: createHash("sha256")
        .update(`${url}|${startsAt}|${clean(first.venueName)}`)
        .digest("hex")
        .slice(0, 24),
      title: clean(detail.eventName),
      description,
      startsAt,
      venue: clean(first.venueName),
      city: "İstanbul",
      district: clean(detail.venueTown),
      address: "",
      price: prices.length ? Math.min(...prices) : null,
      currency: "TRY",
      url,
      imageUrl: image.startsWith("https://") ? image : "",
      category,
      availability: onSale.length ? "available" : "unknown",
      checkedAt: now.toISOString(),
      source: "biletix",
      sourceSessionIds: [...new Set(rows.map((p) => p.performanceCode).filter((id) => typeof id === 'string' || Number.isInteger(id)).map(String))],
      sourceCategory: sourceLabel,
      sourceVersion: "4",
      extraction: "embedded-state",
      ...(attendanceTiming ? { attendanceTiming } : {}),
    });
  }
  // A complete, well-formed performance list containing only past/nonlocal
  // sessions proves this source page is retired from the future city inventory.
  return events;
}

async function extractBubilet($, url, category, sourceCategory, nodes, now, { get } = {}) {
  const slug = new URL(url).pathname.split("/").at(-1);
  const props = await verifiedBubiletDetailInventory($, slug, get ?? (() => { throw new Error('calendar_requires_expansion'); }));
  // Calendar inventory needs a separate verified date expansion; never treat the
  // currently displayed month as the whole production and replace stored sessions.
  if (!['complete_embedded_inventory', 'complete_api_verified_inventory'].includes(props.coverage)) throw new Error("calendar_requires_expansion");
  const base = nodes.find((n) => n["@type"] === "Event" && typeof n.name === "string");
  if (!base) throw new Error("schema_missing");
  category = categorySupportedByEvent(category, base.name, base.description);
  if (!category) throw new Error("unsupported_category");
  const groups = new Map();
  for (const row of props.eventSessions) {
    if (row.cityId !== 34 || row.hideSession === true) continue;
    if (
      typeof row.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(row.date) ||
      !Number.isFinite(Date.parse(row.date)) ||
      !clean(row.venueName) ||
      !Number.isInteger(row.sessionId)
    )
      throw new Error("session_schema_changed");
    if (Date.parse(row.date) < now.getTime()) continue;
    const key = new Date(row.date).toISOString() + "|" + clean(row.venueName);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const events = [];
  for (const [key, rows] of groups) {
    const row = rows[0],
      startsAt = new Date(row.date).toISOString();
    const offered = rows.filter(
      (s) =>
        s.promoteOnly === false &&
        s.isSelectable === true &&
        s.isMarkedSoldOut === false &&
        s.isCombinedTicket !== true &&
        s.isSeasonTicketRenewalOpen !== true,
    );
    const prices = offered
      .map((s) => s.price)
      .filter((p) => typeof p === "number" && Number.isFinite(p) && p >= 0);
    const schema = nodes.find(
      (n) =>
        n.startDate &&
        Date.parse(n.startDate) === Date.parse(row.date) &&
        clean(n.location?.name) === clean(row.venueName),
    );
    const cancelled = /Cancelled|Postponed|Rescheduled/.test(clean(schema?.eventStatus));
    const soldOut = rows.every((s) => s.isMarkedSoldOut === true);
    const image = Array.isArray(base.image) ? base.image[0] : base.image;
    events.push({
      id: createHash("sha256")
        .update(url + "|" + key)
        .digest("hex")
        .slice(0, 24),
      title: clean(base.name),
      description: clean(base.description).slice(0, 5000),
      startsAt,
      venue: clean(row.venueName),
      city: "İstanbul",
      district: "",
      address: clean(schema?.location?.address?.streetAddress),
      price: !cancelled && prices.length ? Math.min(...prices) : null,
      currency: "TRY",
      url,
      imageUrl: typeof image === "string" && image.startsWith("https://") ? image : "",
      category,
      availability: cancelled
        ? "cancelled"
        : soldOut
          ? "sold_out"
          : offered.length
            ? "available"
            : "unknown",
      checkedAt: now.toISOString(),
      source: "bubilet",
      sourceSessionIds: rows.map((row) => String(row.sessionId)),
      ...(sourceCategory ? { sourceCategory } : {}),
      sourceVersion: "4",
      extraction: "embedded-session-state",
    });
  }
  // Independently advertised future session dates must exist in the detailed state.
  // A truncated payload is an error, not evidence that those sessions disappeared.
  const observedDates = new Set(events.map((e) => e.startsAt));
  const corroboratedNonIstanbul = (node) => {
    const timestamp = Date.parse(node.startDate),
      venue = clean(node.location?.name);
    if (!Number.isFinite(timestamp) || !venue) return false;
    const detailedSessions = [
      ...(Array.isArray(props.eventSessions) ? props.eventSessions : []),
      ...(Array.isArray(props.allSessions) ? props.allSessions : []),
    ];
    const matching = detailedSessions.filter(
      (row) =>
        typeof row?.date === "string" &&
        Date.parse(row.date) === timestamp &&
        clean(row.venueName) === venue,
    );
    return (
      matching.length > 0 &&
      matching.every((row) => Number.isInteger(row.cityId) && row.cityId !== 34)
    );
  };
  for (const node of nodes) {
    if (Array.isArray(node.subEvent) && node.subEvent.length) continue;
    if (
      !String(node["@type"]).endsWith("Event") ||
      !node.startDate ||
      Date.parse(node.startDate) < now.getTime()
    )
      continue;
    if (!/istanbul|İstanbul/i.test(clean(node.location?.address?.addressLocality))) continue;
    if (!Number.isFinite(Date.parse(node.startDate))) throw new Error("session_schema_changed");
    // Bubilet JSON-LD can copy the first venue into all subEvents (observed on
    // Usta Komedyen); use the actual session's venue, and corroborate dates only.
    if (
      !observedDates.has(new Date(node.startDate).toISOString()) &&
      !corroboratedNonIstanbul(node)
    )
      throw new Error("session_coverage_mismatch");
  }
  if (!events.length && !props.eventSessions.length) {
    const leaf = nodes.filter((node) => String(node['@type']).endsWith('Event') && !node.subEvent?.length);
    if (!leaf.length || leaf.some((node) => !Number.isFinite(Date.parse(node.startDate)) || Date.parse(node.startDate) >= now.getTime()))
      throw new Error('no_verified_sessions');
  }
  return events;
}
