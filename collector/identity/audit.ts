import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { resolveIdentity } from "./resolve.ts";
import type { IdentityListing } from "./types.ts";

interface FrozenRecord {
  id: string;
  provider: string;
  title: string;
  startsAt: string;
  venue: string;
  /** Explicit counterfactual used only to put a real cross-venue pair in candidate scope. */
  comparisonStartsAt?: string;
  comparisonProvider?: string;
  district?: string;
  address?: string;
  category: string;
}
interface FrozenPair {
  label: string;
  expectedFamily: string;
  expectedMerge: boolean;
  left: FrozenRecord;
  right: FrozenRecord;
}
interface PairFixture {
  schemaVersion: 1;
  source: string;
  train: FrozenPair[];
  heldout: FrozenPair[];
}

function listing(record: FrozenRecord): IdentityListing {
  return {
    listingId: record.id,
    provider: record.comparisonProvider ?? record.provider,
    providerSessionIds: [record.id],
    url: `snapshot://${record.provider}/${record.id}`,
    title: record.title,
    description: "",
    category: record.category,
    startsAt: record.comparisonStartsAt ?? record.startsAt,
    city: "İstanbul",
    venue: { name: record.venue, district: record.district, address: record.address },
  };
}

export interface IdentityAuditReport {
  source: string;
  split: "train" | "heldout" | "all";
  pairs: number;
  expectedFamilies: string[];
  candidates: number;
  autoMerges: number;
  manualMerges: number;
  neverMerges: number;
  unresolved: number;
  wrongMerges: number;
  missedMerges: number;
  deterministicRecall: number;
  sourceRecordIds: string[];
  results: {
    label: string;
    expectedFamily: string;
    expectedMerge: boolean;
    actualMerge: boolean;
    rule: string;
    venueEvidence: string[];
  }[];
}

export function auditIdentityPairs(
  fixture: PairFixture,
  split: "train" | "heldout" | "all" = "all",
): IdentityAuditReport {
  const pairs = split === "all" ? [...fixture.train, ...fixture.heldout] : fixture[split];
  const report: IdentityAuditReport = {
    source: fixture.source,
    split,
    pairs: pairs.length,
    expectedFamilies: [...new Set(pairs.map(({ expectedFamily }) => expectedFamily))].sort(),
    candidates: 0,
    autoMerges: 0,
    manualMerges: 0,
    neverMerges: 0,
    unresolved: 0,
    wrongMerges: 0,
    missedMerges: 0,
    deterministicRecall: 0,
    sourceRecordIds: [...new Set(pairs.flatMap(({ left, right }) => [left.id, right.id]))].sort(),
    results: [],
  };
  for (const pair of pairs) {
    const resolution = resolveIdentity([listing(pair.left), listing(pair.right)]);
    const actualMerge = resolution.sessions.some((session) => session.listingIds.length === 2);
    const decision = resolution.decisions[0];
    if (decision) {
      report.candidates++;
      if (decision.outcome === "auto_merge") report.autoMerges++;
      else if (decision.outcome === "manual_merge") report.manualMerges++;
      else if (decision.outcome === "never_merge") report.neverMerges++;
      else report.unresolved++;
    }
    if (actualMerge && !pair.expectedMerge) report.wrongMerges++;
    if (!actualMerge && pair.expectedMerge) report.missedMerges++;
    const venueEvidence = resolution.venues
      .filter(
        ({ listingIds }) => listingIds.includes(pair.left.id) || listingIds.includes(pair.right.id),
      )
      .flatMap(({ evidence }) => evidence)
      .sort();
    report.results.push({
      label: pair.label,
      expectedFamily: pair.expectedFamily,
      expectedMerge: pair.expectedMerge,
      actualMerge,
      rule: decision?.rule ?? "outside-candidate-scope",
      venueEvidence,
    });
  }
  const expectedMerges = pairs.filter(({ expectedMerge }) => expectedMerge).length;
  report.deterministicRecall = expectedMerges
    ? (expectedMerges - report.missedMerges) / expectedMerges
    : 1;
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const splitArg =
    args.find((value) => value.startsWith("--split="))?.slice("--split=".length) ?? "all";
  if (!["train", "heldout", "all"].includes(splitArg))
    throw new Error(`Invalid split: ${splitArg}`);
  const pathArg =
    args.find((value) => !value.startsWith("--")) ??
    fileURLToPath(new URL("../tests/fixtures/identity-pairs.v1.json", import.meta.url));
  const fixture = JSON.parse(await readFile(pathArg, "utf8")) as PairFixture;
  const report = auditIdentityPairs(fixture, splitArg as "train" | "heldout" | "all");
  console.log(JSON.stringify(report, null, 2));
  if (report.wrongMerges || report.missedMerges) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
