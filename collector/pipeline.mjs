import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { detailUrl } from "./adapters.mjs";

export const sha = (text) => createHash("sha256").update(text).digest("hex");
const normalize = (text) =>
  text
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
export function validateEvent(event, now = new Date()) {
  const errors = [];
  if (!event || typeof event !== "object") return ["invalid_record"];
  for (const key of ["id", "title", "venue", "startsAt", "checkedAt"])
    if (typeof event[key] !== "string" || !event[key].trim()) errors.push(`missing_${key}`);
  const start = Date.parse(event.startsAt),
    checked = Date.parse(event.checkedAt);
  if (!Number.isFinite(start) || start < now.getTime() || start > now.getTime() + 730 * 86400000)
    errors.push("invalid_start");
  if (
    !Number.isFinite(checked) ||
    checked > now.getTime() + 300000 ||
    checked < now.getTime() - 72 * 3600000
  )
    errors.push("invalid_check_time");
  if (event.city !== "İstanbul") errors.push("outside_city");
  if (!["Konser", "Tiyatro", "Stand-up"].includes(event.category)) errors.push("invalid_category");
  if (!["available", "unknown", "cancelled", "sold_out"].includes(event.availability))
    errors.push("invalid_availability");
  if (event.currency !== "TRY") errors.push("invalid_currency");
  if (
    event.price !== null &&
    (typeof event.price !== "number" ||
      !Number.isFinite(event.price) ||
      event.price < 0 ||
      event.price > 50000)
  )
    errors.push("price_outlier");
  const source =
    event.source ??
    (typeof event.url === "string" && event.url.startsWith("https://biletinial.com/")
      ? "biletinial"
      : "");
  if (!detailUrl(event.url, source)) errors.push("invalid_source_url");
  return errors;
}
export function productionKey(event) {
  // Conservative exact normalized match; do not fuzzy-merge different venues/artists.
  return sha([event.title, event.venue, event.category].map(normalize).join("|")).slice(0, 24);
}
export function reconcile(previous, pages, now = new Date()) {
  const updated = new Set(pages.map((page) => page.url));
  const carried = previous.filter((e) => !updated.has(e.url) && validateEvent(e, now).length === 0);
  const combined = [...carried, ...pages.flatMap((page) => page.events)];
  const events = [
    ...new Map(
      combined.map((event) => [event.id, { ...event, productionKey: productionKey(event) }]),
    ).values(),
  ].sort(
    (a, b) =>
      a.startsAt.localeCompare(b.startsAt) ||
      (a.price ?? Infinity) - (b.price ?? Infinity) ||
      a.id.localeCompare(b.id),
  );
  return { events, carried: carried.length };
}
export function publicationGate(previous, events, report, now = new Date()) {
  const oldEligible = previous.filter(
    (e) => validateEvent(e, now).length === 0 && e.availability === "available",
  ).length;
  const eligible = events.filter((e) => e.availability === "available").length;
  if (!report.pages.length || !eligible) return "no_verified_available_events";
  if (oldEligible >= 20 && eligible < oldEligible * 0.6) return "large_catalog_drop";
  return null;
}
export async function readSnapshot(path) {
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(data)) throw new Error("Snapshot must be an array");
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
export async function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n");
  await rename(temp, path);
}
