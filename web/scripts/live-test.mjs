#!/usr/bin/env node
// Phase 1R live test runner. It sends each request of `fixtures/live-1r.json`
// once to `/api/recommend`, keeps the raw responses and writes a review file.
// Reviewers fill each verdict against the card source fields; `summary`
// checks the Phase 1R acceptance rule.
//
//   node scripts/live-test.mjs run --base-url URL --max-requests 60 [--out DIR]
//        [--interval-seconds 190] [--ids l01,l02] [--fixture FILE]
//   node scripts/live-test.mjs review --out DIR
//   node scripts/live-test.mjs summary --out DIR
//
// Searches are paid calls. The runner never retries. It stops at the first
// rate limit, at `--max-requests`, or at a network error. A second `run` on
// the same DIR continues with the cases that have no saved response yet.
// For private staging, put an identity token in BIPLAN_ID_TOKEN. Never write
// the token to a file. Output goes to `work/`, which git ignores.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERDICTS = ['GOOD', 'PARTIAL', 'BAD'];
export const CARD_CHECKS = ['ok', 'violates', 'unclear'];
// A BAD result with one of these causes fails Phase 1R acceptance.
export const BLOCKING_CAUSES = ['parsing', 'missing-data'];
export const CAUSES = [
  ...BLOCKING_CAUSES,
  'retrieval',
  'ranking',
  'identity',
  'catalog-gap',
  'other',
];

const weekday = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Istanbul',
  weekday: 'short',
});
const localDateTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** "Sat 2026-11-07 20:30" in Istanbul time. Reviewers need date and weekday. */
export function istanbulTime(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return null;
  return `${weekday.format(date)} ${localDateTime.format(date)}`;
}

export function cardOf(event) {
  return {
    id: event.id,
    title: event.title,
    startsAt: event.startsAt,
    startsLocal: istanbulTime(event.startsAt),
    venue: event.venue,
    district: event.district,
    city: event.city,
    price: event.price,
    currency: event.currency,
    ...(event.advertisedPrice
      ? { advertisedPrice: event.advertisedPrice }
      : {}),
    category: event.category,
    ...(event.sourceCategory ? { sourceCategory: event.sourceCategory } : {}),
    availability: event.availability,
    source: event.source ?? null,
    url: event.url,
    offers: (event.offers ?? []).map((offer) => ({
      source: offer.source,
      url: offer.url,
      price: offer.price ?? null,
    })),
    ...(event.labels ? { labels: event.labels } : {}),
    check: null,
    note: '',
  };
}

/** Flags that a reviewer must look at. They are hints, not verdicts. */
export function autoFlags(testCase, response) {
  const flags = [];
  const status = response?.body?.status ?? null;
  if (!response || response.httpStatus !== 200)
    flags.push(`http-${response?.httpStatus ?? 'missing'}`);
  if (testCase.outcome === 'decline' && status === 'results')
    flags.push('decline-expected-but-results');
  if (testCase.outcome === 'search' && status === 'needs_input')
    flags.push('clear-request-asked-for-input');
  if (testCase.outcome === 'search' && status === 'empty')
    flags.push('empty-check-catalog');
  const notice = response?.body?.notice ?? '';
  if (/kelime araması/u.test(notice)) flags.push('word-matching-fallback');
  const ids = (response?.body?.recommendations ?? []).map((r) => r.event?.id);
  if (new Set(ids).size !== ids.length) flags.push('duplicate-card-id');
  return flags;
}

export function reviewEntry(testCase, response) {
  const body = response?.body ?? null;
  return {
    id: testCase.id,
    language: testCase.language,
    kind: testCase.kind,
    message: testCase.message,
    expectedOutcome: testCase.outcome,
    hard: testCase.hard ?? [],
    preferences: testCase.preferences ?? [],
    caseNotes: testCase.notes ?? '',
    sentAt: response?.sentAt ?? null,
    sentLocal: response?.sentAt ? istanbulTime(response.sentAt) : null,
    httpStatus: response?.httpStatus ?? null,
    elapsedMs: response?.elapsedMs ?? null,
    status: body?.status ?? null,
    notice: body?.notice ?? body?.error ?? null,
    clarification: body?.clarification ?? null,
    cards: (body?.recommendations ?? []).map((r) => cardOf(r.event)),
    autoFlags: autoFlags(testCase, response),
    verdict: null,
    cause: null,
    note: '',
  };
}

/** Keeps reviewer work when the review file is built again. */
export function mergeReview(previous, next) {
  const old = new Map((previous ?? []).map((entry) => [entry.id, entry]));
  return next.map((entry) => {
    const before = old.get(entry.id);
    if (!before) return entry;
    const cardsBefore = new Map(before.cards.map((card) => [card.id, card]));
    return {
      ...entry,
      verdict: before.verdict,
      cause: before.cause,
      note: before.note,
      cards: entry.cards.map((card) => {
        const reviewed = cardsBefore.get(card.id);
        return reviewed
          ? { ...card, check: reviewed.check, note: reviewed.note }
          : card;
      }),
    };
  });
}

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}

export function summarize(review) {
  const count = (list, key) =>
    list.reduce((acc, item) => {
      const value = item[key] ?? 'unreviewed';
      acc[value] = (acc[value] ?? 0) + 1;
      return acc;
    }, {});
  const sent = review.filter((entry) => entry.httpStatus !== null);
  const cards = review.flatMap((entry) => entry.cards);
  const problems = [];
  for (const entry of review) {
    if (entry.httpStatus === null) problems.push(`${entry.id}: not sent`);
    else if (!VERDICTS.includes(entry.verdict))
      problems.push(`${entry.id}: no verdict`);
    if (entry.verdict === 'BAD' && !CAUSES.includes(entry.cause))
      problems.push(`${entry.id}: BAD without a known cause`);
    if (entry.cause && !CAUSES.includes(entry.cause))
      problems.push(`${entry.id}: unknown cause ${entry.cause}`);
    for (const card of entry.cards) {
      if (!CARD_CHECKS.includes(card.check))
        problems.push(`${entry.id}: card ${card.id} not checked`);
    }
  }
  const blocking = review.filter(
    (entry) => entry.verdict === 'BAD' && BLOCKING_CAUSES.includes(entry.cause),
  );
  const latencies = sent.map((entry) => entry.elapsedMs);
  return {
    cases: review.length,
    sent: sent.length,
    verdicts: count(review, 'verdict'),
    statuses: count(sent, 'status'),
    causes: count(
      review.filter((entry) => entry.verdict === 'BAD'),
      'cause',
    ),
    cards: cards.length,
    cardChecks: count(cards, 'check'),
    autoFlags: review
      .filter((entry) => entry.autoFlags.length)
      .map((entry) => `${entry.id}: ${entry.autoFlags.join(', ')}`),
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
    blocking: blocking.map((entry) => `${entry.id}: ${entry.cause}`),
    problems,
    accepted: problems.length === 0 && blocking.length === 0,
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith('--')) throw new Error(`Unknown argument: ${key}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Missing value for ${key}`);
    options[key.slice(2)] = value;
    i++;
  }
  return { command, options };
}

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadFixture(options) {
  const path = resolve(root, options.fixture ?? 'fixtures/live-1r.json');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function buildReview(out, fixture) {
  const responses = new Map();
  const dir = join(out, 'responses');
  if (existsSync(dir))
    for (const name of await readdir(dir))
      if (name.endsWith('.json'))
        responses.set(
          name.slice(0, -5),
          JSON.parse(await readFile(join(dir, name), 'utf8')),
        );
  const next = fixture.cases.map((testCase) =>
    reviewEntry(testCase, responses.get(testCase.id)),
  );
  const reviewPath = join(out, 'review.json');
  const merged = mergeReview(await readJson(reviewPath, []), next);
  await writeFile(reviewPath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function run(options) {
  const baseUrl = options['base-url'];
  if (!baseUrl) throw new Error('--base-url is required.');
  const maxRequests = Number(options['max-requests']);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1)
    throw new Error('--max-requests is required: it caps the paid searches.');
  const interval = Number(options['interval-seconds'] ?? 190) * 1000;
  const fixture = await loadFixture(options);
  const out = resolve(
    root,
    options.out ?? `work/live-test/${new Date().toISOString().slice(0, 10)}`,
  );
  await mkdir(join(out, 'responses'), { recursive: true });
  const only = options.ids ? new Set(options.ids.split(',')) : null;
  const pending = fixture.cases.filter(
    (testCase) =>
      (!only || only.has(testCase.id)) &&
      !existsSync(join(out, 'responses', `${testCase.id}.json`)),
  );
  const token = process.env.BIPLAN_ID_TOKEN?.trim();
  const endpoint = new URL('/api/recommend', baseUrl).toString();
  let sent = 0;
  for (const testCase of pending) {
    if (sent >= maxRequests) {
      console.log(`Stopped at --max-requests ${maxRequests}.`);
      break;
    }
    if (sent > 0) await sleep(interval);
    const sentAt = new Date().toISOString();
    const started = performance.now();
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ message: testCase.message }),
      });
    } catch (error) {
      console.error(
        `${testCase.id}: network error (${error.message}). Stopped; no retry.`,
      );
      break;
    }
    sent++;
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 500) };
    }
    const record = {
      id: testCase.id,
      message: testCase.message,
      sentAt,
      elapsedMs: Math.round(performance.now() - started),
      httpStatus: response.status,
      serverTiming: response.headers.get('server-timing'),
      body,
    };
    const rateLimited =
      response.status === 429 || body?.code === 'rate_limited';
    // A rate-limited request made no search, so a later run sends it again.
    if (!rateLimited)
      await writeFile(
        join(out, 'responses', `${testCase.id}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
      );
    console.log(
      `${testCase.id}: HTTP ${response.status} ${body?.status ?? ''} ` +
        `${body?.recommendations?.length ?? 0} cards ${record.elapsedMs} ms`,
    );
    if (rateLimited) {
      console.log('Rate limited. Stopped; run again later to continue.');
      break;
    }
  }
  await buildReview(out, fixture);
  console.log(`Review file: ${join(out, 'review.json')}`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'run') return run(options);
  if (!options.out) throw new Error('--out is required.');
  const out = resolve(root, options.out);
  if (command === 'review') {
    await buildReview(out, await loadFixture(options));
    console.log(`Review file: ${join(out, 'review.json')}`);
    return;
  }
  if (command === 'summary') {
    const review = await readJson(join(out, 'review.json'), null);
    if (!review) throw new Error('No review.json. Run `review` first.');
    const summary = summarize(review);
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = summary.accepted ? 0 : 1;
    return;
  }
  throw new Error('Command must be run, review or summary.');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
