import { createHash } from "node:crypto";
import { load } from "cheerio";
import { parseEvents } from "../web/lib/source.ts";

export const BILETINIAL_ORIGIN = "https://biletinial.com";
const ISTANBUL_ALL_NAME = "İstanbul (Tümü)";
const legacyCategory = new Map([
  ["tiyatro", "Tiyatro"], ["muzik", "Konser"], ["sinema", "Sinema"],
  ["futbol", "Spor"], ["spor", "Spor"], ["opera-bale", "Gösteri"],
  ["gosteri", "Gösteri"], ["egitim", "Eğitim"], ["seminer", "Söyleşi"],
  ["eglence", "Gösteri"], ["etkinlik", "Diğer"],
]);

const clean = (value) => typeof value === "string"
  ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  : "";
const absolute = (path) => new URL(path, BILETINIAL_ORIGIN).toString();
const slugOf = (pathname) => pathname.split("/").filter(Boolean).at(-1) ?? "";

/** Parses the source-generated HeaderMenu response; no locally maintained taxonomy. */
export function discoverBiletinialCategories(html) {
  const $ = load(html), found = new Map();
  $(".siteNav a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    let url;
    try { url = new URL(href, BILETINIAL_ORIGIN); } catch { return; }
    if (url.origin !== BILETINIAL_ORIGIN || !/^\/tr-tr\/(?:[^/]+|etkinlikleri\/[^/]+)$/.test(url.pathname)) return;
    const organizerUrl = url.pathname.split("/").filter(Boolean).slice(1).join("/");
    const title = clean($(element).attr("title") || $(element).text());
    found.set(url.pathname, {
      path: url.pathname,
      istanbulPath: url.pathname === "/tr-tr/futbol" ? url.pathname : `${url.pathname.replace(/\/$/, "")}/istanbul`,
      organizerUrl,
      sourceLabel: title,
      listingKind: url.pathname === "/tr-tr/futbol" ? "football" : url.pathname === "/tr-tr/spor" ? "sports" : url.pathname.startsWith("/tr-tr/etkinlikleri/") ? "event-group" : "list",
      category: organizerUrl === "etkinlikleri/stand-up" ? "Stand-up" : (legacyCategory.get(slugOf(url.pathname)) ?? "Diğer"),
    });
  });
  const kids = $("a[href='/tr-tr/kids'], a[href='https://biletinial.com/tr-tr/kids']").first();
  if (kids.length) found.set("/tr-tr/kids", {
    path: "/tr-tr/kids",
    // This page filters by city in-place. The apparent `/kids/istanbul` route is a 404.
    istanbulPath: "/tr-tr/kids",
    organizerUrl: "kids",
    sourceLabel: clean(kids.closest(".yhm_kategori_cocuk").find("h3").first().text()) || "Çocuklar İçin",
    category: "Diğer",
    audience: "kids",
    listingKind: "kids",
  });
  return [...found.values()];
}

/** Source-observed Kids contract; one response contains the complete city aggregate. */
export function biletinialKidsUrl() {
  // The unscoped path redirects (301); collection uses redirect:manual, so call
  // the source-observed Turkish canonical endpoint directly.
  const url = new URL("/tr-tr/List/GetKidsEvents", BILETINIAL_ORIGIN);
  for (const [key, value] of Object.entries({ cityId: 147, cinemaBranchId: 0, filmTypeId: 0, date: "null", minAge: 0, maxAge: 0 }))
    url.searchParams.set(key, String(value));
  return url.toString();
}

export async function collectBiletinialKids(get) {
  const request = biletinialKidsUrl();
  let payload;
  try { payload = JSON.parse(await get(request)); } catch (error) { return { urls: [], request, completion: `failed:${error?.message ?? "invalid_json"}` }; }
  if (!Array.isArray(payload?.Events)) return { urls: [], request, completion: "schema_changed" };
  const urls = new Set();
  for (const item of payload.Events) {
    if (typeof item?.SeoUrl !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.SeoUrl) ||
        typeof item?.OrganizerTypeUrl !== "string" || !/^[a-z0-9-]+$/.test(item.OrganizerTypeUrl))
      return { urls: [...urls], request, completion: "schema_changed" };
    urls.add(absolute(`/tr-tr/${item.OrganizerTypeUrl}/${item.SeoUrl}`));
  }
  return { urls: [...urls], request, completion: "exhausted", total: payload.Events.length };
}

/** Reads city/pagination values from a city-scoped category page. */
export function parseBiletinialListingConfig(html, pageUrl) {
  const $ = load(html), url = new URL(pageUrl, BILETINIAL_ORIGIN);
  const city = $("option").filter((_i, el) => clean($(el).attr("data-name") || $(el).text()) === ISTANBUL_ALL_NAME).first();
  const cityId = Number(city.attr("data-id") || city.attr("value"));
  const cityUrl = city.attr("value") || "";
  const organizerType = clean($("#categoryOrganizerType").attr("value"));
  const organizerMatch = html.match(/organizerUrl:\s*['"]([^'"]+)['"]/);
  const pageSize = Number($("#categoryPageSize").attr("value"));
  const totalCount = Number($("#categoryListCount").attr("value"));
  if (url.origin !== BILETINIAL_ORIGIN || cityId !== 147 || cityUrl !== "istanbul") throw new Error("istanbul_config_missing");
  if (!organizerMatch || !organizerMatch[1] || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200)
    throw new Error("listing_config_missing");
  return { cityId, cityUrl, organizerUrl: organizerMatch[1], organizerType, pageSize, totalCount: Number.isSafeInteger(totalCount) && totalCount >= 0 ? totalCount : null };
}

/** Discovers the server-rendered first batch; later batches come from GetMoreItems. */
export function discoverBiletinialDetails(html) {
  const $ = load(html), urls = new Set();
  $("#eventListContainer a[href], a[data-slider-group^='Categories-'][href], li[data-link], .kategori__etkinlikler_futbol h3 a[href]").each((_index, element) => {
    try {
      const url = new URL($(element).attr("data-link") || $(element).attr("href"), BILETINIAL_ORIGIN);
      if (url.origin === BILETINIAL_ORIGIN && /^\/tr-tr\/[^/]+\/[^/]+$/.test(url.pathname)) urls.add(url.origin + url.pathname);
    } catch { /* malformed source URL */ }
  });
  return [...urls];
}

export function biletinialPageUrl(config, page) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("invalid_page");
  const url = new URL("/List/GetMoreItems", BILETINIAL_ORIGIN);
  for (const [key, value] of Object.entries({ region: "tr-tr", cityId: config.cityId, cityUrl: config.cityUrl, order: 0, isKids: false, isCampaign: false, isForeign: false, organizerUrl: config.organizerUrl, page }))
    url.searchParams.set(key, String(value));
  return url.toString();
}

/** Exhausts the observed GetMoreItems contract; only count/short-page exhaustion is complete. */
export async function collectBiletinialListing(config, get, { maxPages = 100, initialCount = null } = {}) {
  const items = [], requests = [], seen = new Set();
  if (initialCount !== null && (!Number.isSafeInteger(initialCount) || initialCount < 0)) throw new Error("invalid_initial_count");
  if (config.totalCount !== null && initialCount !== null && initialCount >= config.totalCount)
    return { items, requests, completion: "exhausted", totalCount: config.totalCount };
  let expectedTotal = config.totalCount;
  for (let page = 1; page <= maxPages; page++) {
    const url = biletinialPageUrl(config, page); requests.push(url);
    let payload;
    try { payload = JSON.parse(await get(url)); } catch (error) { return { items, requests, completion: `failed:${error?.message ?? "invalid_json"}` }; }
    const rows = Array.isArray(payload?.items) ? payload.items : null;
    if (!rows || (payload.hasMore !== undefined && typeof payload.hasMore !== "boolean"))
      return { items, requests, completion: "schema_changed" };
    const signature = JSON.stringify(rows.map((row) => [row?.organizerUrl, row?.seoUrl, row?.seances ?? row?.Seances]));
    if (seen.has(signature)) return { items, requests, completion: "repeated_page" };
    seen.add(signature); items.push(...rows);
    const suppliedTotal = payload.TotalCount === undefined ? null : Number(payload.TotalCount);
    if (suppliedTotal !== null && (!Number.isSafeInteger(suppliedTotal) || suppliedTotal < 0))
      return { items, requests, completion: "schema_changed" };
    if (suppliedTotal !== null && expectedTotal !== null && suppliedTotal !== expectedTotal)
      return { items, requests, completion: "changed_total", totalCount: suppliedTotal };
    if (suppliedTotal !== null) expectedTotal = suppliedTotal;
    const discovered = (initialCount ?? 0) + items.length;
    if (payload.hasMore === true) {
      if (!rows.length) return { items, requests, completion: "empty_with_more", totalCount: expectedTotal };
      if (rows.length < config.pageSize) return { items, requests, completion: "short_page_with_more", totalCount: expectedTotal };
      continue;
    }
    if (payload.hasMore === false) {
      if (expectedTotal !== null && discovered < expectedTotal)
        return { items, requests, completion: "incomplete_total", totalCount: expectedTotal };
      return { items, requests, completion: "exhausted", totalCount: expectedTotal };
    }
    if (expectedTotal !== null && discovered >= expectedTotal)
      return { items, requests, completion: "exhausted", totalCount: expectedTotal };
    if (rows.length < config.pageSize)
      return { items, requests, completion: expectedTotal === null ? "exhausted" : "incomplete_total", totalCount: expectedTotal };
  }
  return { items, requests, completion: "page_limit" };
}

const flatten = (value) => Array.isArray(value) ? value.flat(Infinity) : [];
const istanbul = (item) => [5, 77, 147].includes(Number(item?.cityId)) || /^istanbul\b/i.test(clean(item?.cityName).normalize("NFD").replace(/\p{M}/gu, ""));

/** Expands every source-supplied session. Rows without a valid session remain unresolved. */
export function expandBiletinialSessions(items, category, now = new Date()) {
  const events = [], unresolved = [];
  for (const item of items) {
    const title = clean(item?.name), venue = clean(item?.saloonName), organizerUrl = clean(item?.organizerUrl), seoUrl = clean(item?.seoUrl);
    const sourceUrl = organizerUrl && seoUrl ? absolute(`/tr-tr/${organizerUrl}/${seoUrl}`) : null;
    const sessions = [...new Set(flatten(item?.seances ?? item?.Seances).filter((value) => typeof value === "string"))];
    if (!title || !sourceUrl || !istanbul(item) || item?.isOpenTicket === true || item?.IsOpenTicket === true || !sessions.length) {
      unresolved.push({ item, reason: item?.isOpenTicket === true || item?.IsOpenTicket === true ? "open_ticket_without_session" : "sessions_missing_or_non_istanbul" });
      continue;
    }
    for (const raw of sessions) {
      if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
        unresolved.push({ item, session: raw, reason: "ambiguous_session_timezone" });
        continue;
      }
      const time = Date.parse(raw);
      if (!Number.isFinite(time) || time < now.getTime() || !venue) { unresolved.push({ item, session: raw, reason: "invalid_session" }); continue; }
      const startsAt = new Date(time).toISOString();
      events.push({
        id: createHash("sha256").update(`${sourceUrl}|${startsAt}|${venue}`).digest("hex").slice(0, 24),
        title, description: clean(item?.description).slice(0, 5000), startsAt, venue,
        city: "İstanbul", district: clean(item?.districtName), address: "", price: null,
        currency: "TRY", url: sourceUrl, imageUrl: item?.imageUrl ? absolute(item.imageUrl) : "",
        category: category || "Diğer", availability: "unknown", checkedAt: now.toISOString(),
        source: "biletinial", sourceVersion: "listing-v1", extraction: "listing-session-array",
        ...(item?.id == null ? {} : { sourceSessionIds: [String(item.id)] }),
      });
    }
  }
  return { events, unresolved };
}

function jsonLdNodes($) {
  const nodes = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    nodes.push(value);
    visit(value["@graph"]);
    visit(value.subEvent);
  };
  $("script[type='application/ld+json']").each((_index, element) => {
    try {
      visit(JSON.parse($(element).text()));
    } catch { /* another schema block may still be valid */ }
  });
  return nodes;
}

const explicitZonedDate = (value) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const istanbulText = (value) => clean(value).normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("tr-TR").includes("istanbul");
const sessionText = (value) => clean(value).normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("tr-TR").replace(/[^a-z0-9]+/g, " ").trim();
const istanbulClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const istanbulWallTime = (value) => {
  const parts = Object.fromEntries(istanbulClock.formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

function conflictingVisibleSessions($, nodes) {
  const visible = new Map();
  $(".ed-biletler__sehir__gun[itemscope]").each((_index, row) => {
    const current = $(row), start = clean(current.find("[itemprop='startDate'][content]").first().attr("content"));
    const title = clean(current.find("[itemprop='name'][content]").first().attr("content"));
    const location = current.find("[itemprop='location']").first();
    const venue = clean(location.attr("title") || location.find("[itemprop='name']").first().text());
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start) || !title || !venue) return;
    const key = `${sessionText(title)}|${sessionText(venue)}|${start.slice(0, 10)}`;
    const times = visible.get(key) || new Set();
    times.add(start.slice(11, 16)); visible.set(key, times);
  });
  return new Set(nodes.filter((node) => {
    if (!explicitZonedDate(node?.startDate)) return false;
    const local = istanbulWallTime(node.startDate);
    const key = `${sessionText(node.name)}|${sessionText(node.location?.name)}|${local.slice(0, 10)}`;
    const times = visible.get(key);
    return times?.size && !times.has(local.slice(11, 16));
  }).map((node) => `${sessionText(node.name)}|${sessionText(node.location?.name)}|${new Date(node.startDate).toISOString()}`));
}

/**
 * Proves that a detail may be retired without turning malformed source data
 * into a false empty result. Every leaf Event must be structurally usable and
 * either past or explicitly located outside Istanbul.
 */
function conclusivelyOccurredBiletinialDetail($) {
  const title = clean($(".yds_cinema_details_info_title h1").first().text());
  const status = $(".yds_cinema_details_buttons > button.goseances");
  const hasSessionEvidence = $("[itemprop='startDate'], button.seanceSelect[data-title], .yn_cinema_salon_info button[data-title]").length > 0;
  return Boolean(title) && status.length === 1 && clean(status.first().text()) === "Bu Etkinlik Ger\u00e7ekle\u015fti" && !hasSessionEvidence;
}

export function canRetireBiletinialDetail($, now = new Date()) {
  const leaves = jsonLdNodes($).filter((node) =>
    [node?.["@type"]].flat().some((type) => typeof type === "string" && type.endsWith("Event")) &&
    !(Array.isArray(node.subEvent) && node.subEvent.length));
  if (!leaves.length) return conclusivelyOccurredBiletinialDetail($);
  return leaves.every((node) => {
    const address = node.location?.address;
    const cityEvidence = clean(`${address?.addressLocality ?? ""} ${address?.addressRegion ?? ""}`);
    if (!clean(node.name) || !clean(node.location?.name) || !explicitZonedDate(node.startDate)) return false;
    if (Date.parse(node.startDate) < now.getTime()) return true;
    return Boolean(cityEvidence) && !istanbulText(cityEvidence);
  });
}

/**
 * Extracts every Event JSON-LD session. Cinema pages without Event sessions are
 * rejected: their Movie schema is metadata, not evidence of a venue/time.
 */
export async function extractBiletinial($, url, fallbackCategory, now = new Date(), options = {}) {
  const canonical = new URL(url, BILETINIAL_ORIGIN);
  if (canonical.origin !== BILETINIAL_ORIGIN || !/^\/tr-tr\/[^/]+\/[^/]+$/.test(canonical.pathname))
    throw new Error("invalid_detail_url");
  const nodes = jsonLdNodes($);
  const hasEvent = nodes.some((node) => [node?.["@type"]].flat().some((type) => typeof type === "string" && type.endsWith("Event")));
  if (!hasEvent) {
    const movie = nodes.find((node) => [node?.["@type"]].flat().includes("Movie"));
    if (movie) {
      if (typeof options.get !== "function") throw new Error("cinema_sessions_require_public_contract");
      return extractCinemaSessions($, canonical, movie, fallbackCategory, now, options);
    }
    if (conclusivelyOccurredBiletinialDetail($)) return [];
    throw new Error("schema_missing");
  }
  // Keep the shared source parser as the single contract for nested JSON-LD,
  // multiple offers, event status, strict timezone and Istanbul evidence.
  const sourceCategory = canonical.pathname.split('/')[2];
  const parsed = await parseEvents($.html(), canonical.origin + canonical.pathname, fallbackCategory || legacyCategory.get(sourceCategory) || "Diğer", now);
  const conflicts = conflictingVisibleSessions($, nodes);
  const parsedConflict = parsed.some((event) => conflicts.has(`${sessionText(event.title)}|${sessionText(event.venue)}|${event.startsAt}`));
  if (parsedConflict) throw new Error("session_time_conflict");
  const events = parsed.map((event) => ({
    ...event,
    category: typeof options.categoryForEvent === "function"
      ? options.categoryForEvent(event.category, event.title, event.description)
      : event.category,
    source: "biletinial",
    sourceCategory,
    sourceVersion: "4",
    extraction: "json-ld-all-sessions",
  }));
  if (!events.length) {
    if (canRetireBiletinialDetail($, now)) return [];
    throw new Error("no_verified_istanbul_sessions");
  }
  return events;
}
async function extractCinemaSessions($, canonical, movie, fallbackCategory, now, options) {
  const html = $.html(), eventId = html.match(/\bvar\s+eventId\s*=\s*(\d+)\s*;/)?.[1];
  const langId = html.match(/\bvar\s+langId\s*=\s*['"]?(\d+)['"]?\s*;/)?.[1];
  const countryCode = html.match(/\bvar\s+countryCode\s*=\s*['"]([a-z]{2})['"]\s*;/i)?.[1];
  if (!eventId || !langId || !countryCode) throw new Error("cinema_contract_missing");
  const datesUrl = new URL("/tr-tr/details/GetDateListForCity", BILETINIAL_ORIGIN);
  for (const [key, value] of Object.entries({ eventId, langId, cityId: 147 })) datesUrl.searchParams.set(key, String(value));
  const dateHtml = await options.get(datesUrl.toString()), date$ = load(dateHtml);
  const dates = [...new Set(date$("[data-date]").map((_i, el) => date$(el).attr("data-date")).get())]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
  if (!dates.length) throw new Error("cinema_dates_missing");
  const events = [], title = clean(movie.name), description = clean(movie.description).slice(0, 5000);
  for (const date of dates) {
    const sessionUrl = absolute(`/dynamic/get_seances/${eventId}/147/${date}/${langId}/${countryCode}`);
    const sessionHtml = await options.get(sessionUrl), session$ = load(sessionHtml);
    session$(".yn_cinema").each((_index, cinema) => {
      const venue = clean(session$(cinema).find(".yn_cinema_info_titleh2").first().text());
      session$(cinema).find(".yn_cinema_salon_info button[data-title]").each((_buttonIndex, button) => {
        const clock = clean(session$(button).text());
        if (!/^\d{2}:\d{2}$/.test(clock) || !venue) return;
        const raw = `${date}T${clock}:00+03:00`, time = Date.parse(raw);
        if (!Number.isFinite(time) || time < now.getTime()) return;
        const startsAt = new Date(time).toISOString();
        events.push({
          id: createHash("sha256").update(`${canonical.origin + canonical.pathname}|${startsAt}|${venue}`).digest("hex").slice(0, 24),
          title, description, startsAt, venue, city: "İstanbul", district: "", address: "",
          price: null, currency: "TRY", url: canonical.origin + canonical.pathname,
          imageUrl: typeof movie.image === "string" && movie.image.startsWith("https://") ? movie.image : "",
          category: "Sinema", sourceCategory: 'sinema', availability: "unknown", checkedAt: now.toISOString(),
          source: "biletinial", sourceVersion: "4", extraction: "cinema-public-session-html",
          ...(clean(session$(button).attr("data-title")) ? { sourceSessionIds: [clean(session$(button).attr("data-title"))] } : {}),
        });
      });
    });
  }
  if (!events.length) throw new Error("no_verified_istanbul_sessions");
  return events;
}
