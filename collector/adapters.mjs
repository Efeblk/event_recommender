import { createHash } from "node:crypto";
import { jsonLd, parseEvents } from "../web/lib/source.ts";

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
    paths: [
      ["/category/MUSIC/ISTANBUL/tr", "Konser"],
      ["/anasayfa/ISTANBUL/tr", null],
    ],
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
  const events = await parseEvents(html, url, category, now);
  // An Event schema alone is insufficient evidence that a page is now empty.
  // Preserve old rows when a redesign drops essential fields or all rows are rejected.
  if (!events.length) throw new Error("no_verified_sessions");
  return events.map((event) => ({ ...event, source, sourceVersion: "2", extraction: "json-ld" }));
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
  const category = categoryOf(
    `${detail.subCategory ?? ""} ${detail.eventCategoryCode === "MUSIC" ? "music" : ""}`,
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
      sourceVersion: "2",
      extraction: "embedded-state",
    });
  }
  if (!events.length) throw new Error("no_verified_sessions");
  return events;
}
