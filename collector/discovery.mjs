import { detailUrl, discover } from "./adapters.mjs";
import { sha } from "./pipeline.mjs";
import { flightObjects } from "./flight.mjs";

// Public requests observed from scrolling the live sites on 2026-09-09.
export async function expandListing($, source, url, get, { maxPages = 20, now = new Date() } = {}) {
  const urls = new Set(discover($, source));
  const initial = urls.size;
  const requests = [];
  const signatures = new Set();
  let completion = "unsupported_listing";
  let total = null;
  const add = (raw) => {
    const canonical = detailUrl(raw, source);
    if (!canonical) throw new Error("invalid_discovery_url");
    urls.add(canonical);
  };
  async function read(endpoint, options) {
    let text;
    for (let attempt = 0; ; attempt++) {
      try {
        text = await get(endpoint, options);
        break;
      } catch (error) {
        if (attempt >= 2 || error.name === "NonRetryableError") throw error;
      }
    }
    const signature = sha(text);
    requests.push({
      url: endpoint,
      method: options?.method ?? "GET",
      ...(options?.body ? { body: options.body } : {}),
      contentHash: signature,
    });
    return JSON.parse(text);
  }
  function repeated(items) {
    const signature = sha(JSON.stringify(items));
    if (signatures.has(signature)) return true;
    signatures.add(signature);
    return false;
  }
  try {
    if (source === "biletinial") {
      const html = $.html();
      if (html.includes("/EventGroup/eventGroupIndex.js")) {
        const groupId = html.match(/var EVENT_GROUP_ID\s*=\s*(\d+)/)?.[1];
        const pageSize = Number(html.match(/var PAGE_SIZE\s*=\s*(\d+)/)?.[1]);
        if (!groupId || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
          throw new Error("listing_config_changed");
        completion = "page_limit";
        for (let page = 1; page <= maxPages; page++) {
          const params = new URLSearchParams({
            eventGroupId: groupId,
            type: "events",
            cityId: "147",
            filmTypesId: "0",
            page: String(page),
            pageSize: String(pageSize),
          });
          const data = await read(`https://biletinial.com/tr-tr/EventGroup/GetData?${params}`);
          if (!Array.isArray(data.Data) || !Number.isInteger(data.TotalCount))
            throw new Error("listing_schema_changed");
          if (total !== null && total !== data.TotalCount) {
            completion = "total_changed";
            break;
          }
          total = data.TotalCount;
          if (repeated(data.Data)) {
            completion = "repeated_page";
            break;
          }
          for (const item of data.Data) {
            if (
              typeof item.SeoUrl !== "string" ||
              !/^[a-zA-Z0-9_-]+$/.test(item.SeoUrl) ||
              !/^(muzik|tiyatro|gosteri|etkinlik)$/.test(item.tipForUrl)
            )
              throw new Error("listing_schema_changed");
            add(`/tr-tr/${item.tipForUrl}/${item.SeoUrl}`);
          }
          requests.at(-1).items = data.Data.length;
          if ((page - 1) * pageSize + data.Data.length >= total) {
            completion = "exhausted";
            break;
          }
          if (data.Data.length !== pageSize) {
            completion = "short_page";
            break;
          }
        }
        return { urls: [...urls], initial, requests, completion, total };
      }
      if (!html.includes("/List/GetMoreItems")) throw new Error("listing_config_changed");
      // Read the source's rendered filter configuration; do not invent a city/category mapping.
      const cityId = html.match(/cityId:\s*'([0-9]+)'/)?.[1];
      const organizer = html.match(/organizerUrl:\s*'([a-z-]+)'/)?.[1];
      if (!cityId || !organizer || !html.includes("cityUrl: 'istanbul'"))
        throw new Error("listing_config_changed");
      completion = "page_limit";
      for (let page = 1; page <= maxPages; page++) {
        const params = new URLSearchParams({
          region: "tr-tr",
          cityId,
          cityUrl: "istanbul",
          order: "0",
          isKids: "false",
          isCampaign: "false",
          isForeign: "false",
          organizerUrl: organizer,
          page: String(page),
        });
        const data = await read(`https://biletinial.com/tr-tr/List/GetMoreItems?${params}`);
        if (!Array.isArray(data.items) || typeof data.hasMore !== "boolean")
          throw new Error("listing_schema_changed");
        if (repeated(data.items)) {
          completion = "repeated_page";
          break;
        }
        for (const item of data.items) {
          if (
            typeof item.seoUrl !== "string" ||
            !/^[a-zA-Z0-9_-]+$/.test(item.seoUrl) ||
            !/^(muzik|tiyatro|gosteri|etkinlik)$/.test(item.organizerUrl)
          )
            throw new Error("listing_schema_changed");
          add(`/tr-tr/${item.organizerUrl}/${item.seoUrl}`);
        }
        requests.at(-1).items = data.items.length;
        if (!data.hasMore) {
          completion = "exhausted";
          break;
        }
        if (!data.items.length) {
          completion = "empty_with_more";
          break;
        }
      }
    } else if (source === "bubilet") {
      const tag = new URL(url).pathname.split("/").at(-1);
      const props = flightObjects($).find(
        (x) => x.citySlug === "istanbul" && Array.isArray(x.events) && Number.isInteger(x.tagId),
      );
      if (
        !props ||
        props.cityId !== 34 ||
        !["konser", "tiyatro", "stand-up"].includes(tag) ||
        props.currentTag?.slug !== tag
      )
        throw new Error("listing_config_changed");
      const data = await read(
        `https://platform.api.bubilet.com.tr/v3/event/city/34/tag/${props.tagId}`,
      );
      if (!Array.isArray(data) || !data.length) throw new Error("listing_schema_changed");
      const full = new Set();
      for (const item of data) {
        if (
          typeof item.slug !== "string" ||
          !/^[a-zA-Z0-9_-]+$/.test(item.slug) ||
          !Array.isArray(item.sessions)
        )
          throw new Error("listing_schema_changed");
        const path = `/istanbul/etkinlik/${item.slug}`;
        add(path);
        full.add(detailUrl(path, source));
      }
      // The first server-rendered batch must be contained in the full response.
      if (props.events.some((e) => !full.has(detailUrl(`/istanbul/etkinlik/${e.slug}`, source))))
        throw new Error("initial_batch_missing");
      total = data.length;
      requests.at(-1).items = data.length;
      completion = "exhausted";
    } else if (source === "biletix") {
      const startDay = now.toISOString().slice(0, 10);
      const endDay = new Date(now.getTime() + 730 * 86400000).toISOString().slice(0, 10);
      const rows = 100;
      completion = "page_limit";
      for (let page = 0; page < maxPages; page++) {
        const offset = page * rows;
        const body = new URLSearchParams({
          wt: "json",
          q: "*:*",
          sort: "start asc,id asc",
          start: String(offset),
          rows: String(rows),
        });
        body.append(
          "fq",
          `(start:[${startDay}T00:00:00Z TO ${endDay}T23:59:59Z] OR end:[${startDay}T00:00:00Z TO ${endDay}T23:59:59Z])`,
        );
        body.append("fq", 'city:"İstanbul"');
        body.append("fq", "category:(MUSIC OR ART)");
        body.append("fq", "type:event");
        const data = await read("https://www.biletix.com/solr/tr/select", {
          method: "POST",
          body: body.toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        const result = data.response;
        if (
          data.responseHeader?.status !== 0 ||
          !Array.isArray(result?.docs) ||
          !Number.isInteger(result.numFound) ||
          result.start !== offset
        )
          throw new Error("listing_schema_changed");
        if (total !== null && total !== result.numFound) {
          completion = "total_changed";
          break;
        }
        total = result.numFound;
        if (repeated(result.docs)) {
          completion = "repeated_page";
          break;
        }
        for (const item of result.docs) {
          if (
            !/^[A-Z0-9]+$/.test(item.id) ||
            item.type !== "event" ||
            ![item.city].flat().includes("İstanbul") ||
            !["MUSIC", "ART"].includes(item.category)
          )
            throw new Error("listing_schema_changed");
          add(`/etkinlik/${item.id}/ISTANBUL/tr`);
        }
        requests.at(-1).items = result.docs.length;
        requests.at(-1).offset = offset;
        if (offset + result.docs.length >= total) {
          completion = "exhausted";
          break;
        }
        if (result.docs.length !== rows) {
          completion = "short_page";
          break;
        }
      }
    }
  } catch (error) {
    completion = `failed:${error.message}`;
  }
  return { urls: [...urls], initial, requests, completion, total };
}
