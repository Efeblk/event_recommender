import { createHash } from "node:crypto";
import { flightObjects } from "./flight.mjs";

export const BUBILET_CITY_URL = "https://www.bubilet.com.tr/istanbul";
export const BUBILET_API_ORIGIN = "https://platform.api.bubilet.com.tr";

const validSlug = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value) && value !== "-";
const validTagSlug = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);

function cityPayload($) {
  return flightObjects($).find(
    (value) =>
      value &&
      Array.isArray(value.tags) &&
      Array.isArray(value.pages) &&
      value.tags.every((tag) => tag && typeof tag === "object"),
  );
}

export function bubiletTaxonomy($) {
  const payload = cityPayload($);
  if (!payload) throw new Error("bubilet_taxonomy_missing");
  const seen = new Set();
  return payload.tags
    .map((tag) => ({
      id: tag.id,
      slug: tag.slug,
      name: tag.name,
      order: tag.order,
      isHomepage: tag.isHomepage === true,
      isDefault: tag.isDefault === true,
    }))
    .filter((tag) => {
      if (
        !Number.isInteger(tag.id) ||
        tag.id < 1 ||
        !validTagSlug(tag.slug) ||
        typeof tag.name !== "string" ||
        !tag.name.trim() ||
        seen.has(tag.id)
      )
        throw new Error("bubilet_taxonomy_changed");
      seen.add(tag.id);
      return true;
    })
    .sort((a, b) => a.id - b.id);
}

// Bubilet exposes no complete city endpoint: /v3/event/city/34 is 404 and the
// default Trendler tag omits live workshop and sport productions. Exhaust every
// provider-exposed tag, deduplicate by stable slug, and make a bounded run's
// backlog explicit rather than silently calling it complete.
export async function discoverBubiletCity(
  $,
  get,
  { maxTags = Infinity, completedTagIds = [] } = {},
) {
  const taxonomy = bubiletTaxonomy($);
  if (!(maxTags === Infinity || (Number.isInteger(maxTags) && maxTags >= 0)))
    throw new Error("invalid_bubilet_tag_budget");
  const completed = new Set(completedTagIds);
  if ([...completed].some((id) => !taxonomy.some((tag) => tag.id === id)))
    throw new Error("unknown_bubilet_checkpoint_tag");
  const pending = taxonomy.filter((tag) => !completed.has(tag.id));
  const selected = pending.slice(0, maxTags);
  const productions = new Map();
  const requests = [];
  const failedTags = [];
  for (const tag of selected) {
    const endpoint = `${BUBILET_API_ORIGIN}/v3/event/city/34/tag/${tag.id}`;
    try {
      const text = await get(endpoint);
      let rows;
      try {
        rows = JSON.parse(text);
      } catch {
        throw new Error("bubilet_listing_invalid_json");
      }
      if (!Array.isArray(rows)) throw new Error("bubilet_listing_schema_changed");
      if (rows.some((row) => !row || !validSlug(row.slug) || !Array.isArray(row.sessions)))
        throw new Error("bubilet_listing_schema_changed");
      for (const row of rows) {
        const existing = productions.get(row.slug) ?? {
          slug: row.slug,
          url: `https://www.bubilet.com.tr/istanbul/etkinlik/${row.slug}`,
          sourceCategories: [],
        };
        if (!existing.sourceCategories.some((item) => item.id === tag.id))
          existing.sourceCategories.push({ id: tag.id, slug: tag.slug, name: tag.name });
        productions.set(row.slug, existing);
      }
      requests.push({
        url: endpoint,
        tagId: tag.id,
        tagSlug: tag.slug,
        items: rows.length,
        contentHash: createHash("sha256").update(text).digest("hex"),
      });
      completed.add(tag.id);
    } catch (error) {
      failedTags.push({
        id: tag.id,
        slug: tag.slug,
        name: tag.name,
        error: error instanceof Error ? error.message : "unknown_error",
      });
    }
  }
  const remainingTags = taxonomy.filter((tag) => !completed.has(tag.id));
  return {
    productions: [...productions.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    taxonomy,
    completedTagIds: [...completed].sort((a, b) => a - b),
    remainingTags,
    failedTags,
    requests,
    completion: failedTags.length
      ? "failed_tags"
      : remainingTags.length
        ? "tag_budget"
        : "exhausted",
  };
}

export async function verifiedBubiletDetailInventory($, expectedSlug, get) {
  const embedded = bubiletDetailInventory($, expectedSlug);
  if (embedded.coverage !== "calendar_ui_inventory_unverified") return embedded;
  if (!Number.isInteger(embedded.eventId) || embedded.eventId < 1)
    throw new Error("bubilet_event_id_missing");
  const endpoint = `${BUBILET_API_ORIGIN}/v2/event/${embedded.eventId}/city/34/sessions`;
  const text = await get(endpoint);
  let response;
  try {
    response = JSON.parse(text);
  } catch {
    throw new Error("bubilet_session_inventory_invalid_json");
  }
  if (!response || !Array.isArray(response.sessions))
    throw new Error("bubilet_session_inventory_schema_changed");
  const validIds = (rows, key) => {
    const ids = rows.map((row) => row?.[key]);
    if (
      ids.some((id) => !Number.isInteger(id)) ||
      new Set(ids).size !== ids.length ||
      rows.some((row) => row?.cityId !== 34)
    )
      throw new Error("bubilet_session_inventory_schema_changed");
    return ids.sort((a, b) => a - b);
  };
  const embeddedIds = validIds(embedded.eventSessions, "sessionId");
  const currentIds = validIds(response.sessions, "sessionId");
  if (JSON.stringify(embeddedIds) !== JSON.stringify(currentIds))
    throw new Error("bubilet_session_inventory_mismatch");
  return {
    ...embedded,
    eventSessions: response.sessions,
    coverage: "complete_api_verified_inventory",
    verification: {
      url: endpoint,
      contentHash: createHash("sha256").update(text).digest("hex"),
      sessions: currentIds.length,
    },
  };
}

export function bubiletDetailInventory($, expectedSlug) {
  if (!validSlug(expectedSlug)) throw new Error("invalid_bubilet_slug");
  const matches = flightObjects($).filter(
    (value) =>
      value?.eventSlug === expectedSlug &&
      value.cityId === 34 &&
      Array.isArray(value.eventSessions),
  );
  if (matches.length !== 1) throw new Error("bubilet_session_schema_missing");
  const state = matches[0];
  let calendarBased = state.calendarBased;
  if (typeof calendarBased !== "boolean") {
    // Sports pages use a second verified server shape without calendarBased or
    // allSessions. Accept it only when the production summary independently
    // advertises exactly the same session ids as the detailed ticket state.
    const summary = flightObjects($).find(
      (value) =>
        value?.slug === expectedSlug &&
        Array.isArray(value.sessions) &&
        value.sessions.every((session) => Number.isInteger(session?.id)),
    );
    const summaryIds = summary?.sessions.map((session) => session.id).sort((a, b) => a - b);
    const detailIds = state.eventSessions
      .map((session) => session?.sessionId)
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
    if (
      !summaryIds ||
      summaryIds.length !== state.eventSessions.length ||
      JSON.stringify(summaryIds) !== JSON.stringify(detailIds)
    )
      throw new Error("bubilet_calendar_flag_missing");
    calendarBased = false;
  }
  return {
    eventId: state.eventId,
    eventSlug: expectedSlug,
    cityId: 34,
    calendarBased,
    eventSessions: state.eventSessions,
    allSessions: Array.isArray(state.allSessions) ? state.allSessions : [],
    coverage: calendarBased
      ? "calendar_ui_inventory_unverified"
      : "complete_embedded_inventory",
  };
}
