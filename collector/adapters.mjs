import { createHash } from "node:crypto";
import { flightObjects } from "./flight.mjs";
import { jsonLd, parseEvents } from "../web/lib/source.ts";
import { hasSupportedEventFormat } from "../web/lib/event-format.ts";

export const sources = {
  biletinial: {
    origin: "https://biletinial.com",
    paths: [
      ["/tr-tr/muzik/istanbul", "Konser"],
      ["/tr-tr/tiyatro/istanbul", "Tiyatro"],
      ["/tr-tr/etkinlikleri/stand-up", "Stand-up"],
    ],
    detail: /^\/tr-tr\/(muzik|tiyatro|gosteri|etkinlik)\/[^/]+$/,
  },
  bubilet: {
    origin: "https://www.bubilet.com.tr",
    paths: [
      ["/istanbul/etiket/konser", "Konser"],
      ["/istanbul/etiket/tiyatro", "Tiyatro"],
      ["/istanbul/etiket/stand-up", "Stand-up"],
    ],
    detail: /^\/istanbul\/etkinlik\/[^/]+$/,
  },
  biletix: {
    origin: "https://www.biletix.com",
    paths: [["/search/ISTANBUL/tr", null]],
    detail: /^\/etkinlik\/([A-Z0-9]+)\/ISTANBUL\/tr(?:\/[^/]+)?$/,
  },
};
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
  if (/stand[ -]?up/i.test(text)) return "Stand-up";
  if (/tiyatro/i.test(text)) return "Tiyatro";
  if (/konser|müzik|music/i.test(text)) return "Konser";
  return null;
}
export function categorySupportedByEvent(category, title, description) {
  return category && hasSupportedEventFormat({ title: clean(title), description: clean(description) })
    ? category
    : null;
}
export async function extract($, source, url, fallbackCategory, now = new Date()) {
  const html = $.html();
  if (source === "biletix") return extractBiletix($, url, now);
  const nodes = jsonLd(html);
  const eventNodes = nodes.filter((node) =>
    [node["@type"]].flat().some((t) => typeof t === "string" && t.endsWith("Event")),
  );
  if (!eventNodes.length) throw new Error("schema_missing");
  let category = source === "biletinial" ? fallbackCategory : null;
  if (source === "bubilet") {
    // Prefer the explicit source breadcrumb over a listing/category guess.
    const crumbs = nodes
      .filter((n) => n["@type"] === "BreadcrumbList")
      .flatMap((n) => n.itemListElement ?? []);
    category = crumbs.map((c) => categoryOf(clean(c.name))).find(Boolean) ?? fallbackCategory;
  }
  if (!category) throw new Error("unsupported_category");
  if (source === "bubilet") return extractBubilet($, url, category, nodes, now);
  const events = await parseEvents(html, url, category, now);
  // An Event schema alone is insufficient evidence that a page is now empty.
  // Preserve old rows when a redesign drops essential fields or all rows are rejected.
  if (!events.length) throw new Error("no_verified_sessions");
  const supported = events.filter((event) =>
    categorySupportedByEvent(category, event.title, event.description),
  );
  if (!supported.length) throw new Error("unsupported_category");
  return supported.map((event) => ({ ...event, source, sourceVersion: "3", extraction: "json-ld" }));
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
  const sourceCategory = categoryOf(
    `${detail.subCategory ?? ""} ${detail.eventCategoryCode === "MUSIC" ? "music" : ""}`,
  );
  const category = categorySupportedByEvent(
    sourceCategory,
    detail.eventName,
    detail.eventDescription,
  );
  if (!category) throw new Error("unsupported_category");
  const image = $('meta[property="og:image"]').attr("content") ?? "";
  const groups = new Map();
  for (const p of performances) {
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
      .filter((p) => Number.isSafeInteger(p) && p >= 0 && p <= 10000000)
      .map((p) => p / 100);
    events.push({
      id: createHash("sha256")
        .update(`${url}|${startsAt}|${clean(first.venueName)}`)
        .digest("hex")
        .slice(0, 24),
      title: clean(detail.eventName),
      description: clean(detail.eventDescription).slice(0, 5000),
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
      sourceVersion: "3",
      extraction: "embedded-state",
    });
  }
  if (!events.length) throw new Error("no_verified_sessions");
  return events;
}

function extractBubilet($, url, category, nodes, now) {
  const slug = new URL(url).pathname.split("/").at(-1);
  const props = flightObjects($).find(
    (x) => x.eventSlug === slug && x.cityId === 34 && Array.isArray(x.eventSessions),
  );
  if (!props) throw new Error("session_schema_missing");
  // Calendar inventory needs a separate verified date expansion; never treat the
  // currently displayed month as the whole production and replace stored sessions.
  if (props.calendarBased !== false) throw new Error("calendar_requires_expansion");
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
      sourceVersion: "3",
      extraction: "embedded-session-state",
    });
  }
  // Independently advertised future session dates must exist in the detailed state.
  // A truncated payload is an error, not evidence that those sessions disappeared.
  const observedDates = new Set(events.map((e) => e.startsAt));
  const corroboratedNonIstanbul = (node) => {
    if (!Array.isArray(props.allSessions)) return false;
    const timestamp = Date.parse(node.startDate),
      venue = clean(node.location?.name);
    if (!Number.isFinite(timestamp) || !venue) return false;
    const matching = props.allSessions.filter(
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
  if (!events.length) throw new Error("no_verified_sessions");
  return events;
}
