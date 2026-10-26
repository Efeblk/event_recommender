import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  conditionSignatures,
  fromGoldenFixture,
  scoreCase,
  signatureKind,
  summarize,
  validateHardFixture,
  type ActualOutcome,
  type CaseScore,
  type HardCase,
  type HardFixture,
  type KindCounts,
  type PlanEvalSummary,
} from '../evals/plan-eval.ts';
import { inputReaderFrom, type InputReader } from '../lib/interpreter-config.ts';
import { jevConfigFrom, type JevConfig } from '../lib/jev.ts';
import { validateSearchPlan } from '../lib/plan-evidence.ts';
import { validatePlanState } from '../lib/plan-state.ts';
import { interpretSpanInput } from '../lib/span-interpreter.ts';
import type { ParserInput } from '../parser/contract.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_RESERVATION_USD = 0.001;
const LIVE_INTERVAL_MS = 2000;

export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export interface PlanEvalBudget {
  scope: string;
  jevCapUsd: number;
  approvedBy: string;
  approvedAt: string;
}

export interface PlanEvalRow {
  id: string;
  actual: ActualOutcome | null;
  score: CaseScore;
  error?: string;
}

export interface PlanEvalOutput {
  schemaVersion: 1;
  fixtureSha256: string;
  referenceTime: string;
  model: string;
  reader: InputReader;
  mode: 'live' | 'offline';
  rows: PlanEvalRow[];
  summary: PlanEvalSummary & { errors: number };
}

export function workPath(
  targetPath: string,
  workRoot = resolve(root, 'work'),
): string {
  const full = resolve(root, targetPath);
  const child = relative(workRoot, full);
  if (
    !child ||
    child.startsWith('..') ||
    resolve(workRoot, child) !== full
  ) {
    throw new Error(
      'Plan eval cache, budget and output must stay under web/work.',
    );
  }
  return full;
}

export function istanbulReferenceDate(referenceTime: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(referenceTime));
}

function validateBudget(budget: PlanEvalBudget | undefined): PlanEvalBudget {
  if (
    !budget ||
    typeof budget.scope !== 'string' ||
    !budget.scope.trim() ||
    typeof budget.jevCapUsd !== 'number' ||
    !Number.isFinite(budget.jevCapUsd) ||
    budget.jevCapUsd <= 0 ||
    typeof budget.approvedBy !== 'string' ||
    !budget.approvedBy.trim() ||
    typeof budget.approvedAt !== 'string' ||
    !Number.isFinite(Date.parse(budget.approvedAt))
  ) {
    throw new Error('Valid user-approved budget is required for live mode.');
  }
  return budget;
}

export interface TransportOptions {
  cacheDir: string;
  ledgerPath?: string;
  live?: boolean;
  budget?: PlanEvalBudget;
  network?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export class PlanEvalTransport {
  hits = 0;
  paidCalls = 0;
  halted = false;
  lastCallError: string | null = null;
  private lastLiveCallAt = 0;
  private options: TransportOptions;

  constructor(options: TransportOptions) {
    this.options = options;
  }

  clearCallError(): void {
    this.lastCallError = null;
  }

  fetcher: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    const key = sha256(`${body}${url}`);
    const file = join(this.options.cacheDir, `${key}.json`);

    let cachedRaw: string | undefined;
    try {
      cachedRaw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.lastCallError = 'cache read error';
        throw error;
      }
    }

    if (cachedRaw !== undefined) {
      const entry = JSON.parse(cachedRaw) as {
        status: number;
        body: string;
        sha256: string;
      };
      const bytes = Buffer.from(entry.body, 'base64');
      if (
        !Number.isInteger(entry.status) ||
        typeof entry.body !== 'string' ||
        sha256(bytes) !== entry.sha256
      ) {
        this.lastCallError = 'corrupt cache entry';
        throw new Error('Corrupt plan-eval cache entry.');
      }
      this.hits++;
      return new Response(bytes.toString('utf8'), {
        status: entry.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!this.options.live) {
      this.lastCallError = 'cache miss';
      throw new Error('cache miss');
    }

    if (this.halted) {
      this.lastCallError = 'live halted after previous provider error';
      throw new Error(this.lastCallError);
    }

    const budget = validateBudget(this.options.budget);
    const ledgerPath =
      this.options.ledgerPath ??
      resolve(root, 'work/plan-eval/budget-ledger.jsonl');
    await mkdir(dirname(ledgerPath), { recursive: true });
    await mkdir(this.options.cacheDir, { recursive: true });

    let ledgerText = '';
    try {
      ledgerText = await readFile(ledgerPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.halted = true;
        this.lastCallError = 'ledger read error';
        throw error;
      }
    }

    const entries = ledgerText
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            key: string;
            reservedUsd: number;
            at: string;
          },
      );

    if (entries.some((entry) => entry.key === key)) {
      this.halted = true;
      this.lastCallError = 'duplicate live attempt; no automatic retry';
      throw new Error(this.lastCallError);
    }

    const totalReserved = entries.reduce(
      (sum, entry) => sum + entry.reservedUsd,
      0,
    );
    if (totalReserved + LIVE_RESERVATION_USD > budget.jevCapUsd + 1e-9) {
      this.halted = true;
      this.lastCallError = 'budget cap exceeded';
      throw new Error(this.lastCallError);
    }

    const nowFn = this.options.now ?? Date.now;
    const waitFn =
      this.options.wait ??
      ((ms: number) => new Promise((res) => setTimeout(res, ms)));
    if (this.lastLiveCallAt > 0) {
      const waitMs = Math.max(
        0,
        this.lastLiveCallAt + LIVE_INTERVAL_MS - nowFn(),
      );
      if (waitMs > 0) await waitFn(waitMs);
    }

    const ledgerHandle = await open(ledgerPath, 'a', 0o600);
    try {
      await ledgerHandle.write(
        `${JSON.stringify({
          key,
          reservedUsd: LIVE_RESERVATION_USD,
          at: new Date().toISOString(),
        })}\n`,
      );
      await ledgerHandle.sync();
    } finally {
      await ledgerHandle.close();
    }

    this.paidCalls++;
    this.lastLiveCallAt = nowFn();

    let response: Response;
    try {
      response = await (this.options.network ?? fetch)(url, init);
    } catch (error) {
      this.halted = true;
      this.lastCallError =
        error instanceof Error ? error.message : 'provider network error';
      throw error;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      this.halted = true;
      this.lastCallError = `provider HTTP ${response.status}`;
      throw new Error(this.lastCallError);
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      this.halted = true;
      this.lastCallError = 'provider response read error';
      throw error;
    }

    const digest = sha256(bytes);
    const bodyBase64 = bytes.toString('base64');
    await writeFile(
      file,
      `${JSON.stringify({
        status: response.status,
        body: bodyBase64,
        sha256: digest,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );

    return new Response(bytes.toString('utf8'), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function errorScoreForCase(item: HardCase): CaseScore {
  const expectedHard = item.expected
    ? conditionSignatures(item.expected.hard)
    : new Set<string>();
  const byKind: Record<string, KindCounts> = {};
  for (const sig of expectedHard) {
    const kind = signatureKind(sig);
    byKind[kind] ??= { tp: 0, fp: 0, fn: 0 };
    byKind[kind].fn++;
  }
  return {
    id: item.id,
    kind: item.kind,
    expectedOutcome: item.outcome,
    pass: false,
    outcomeCorrect: false,
    missing: [...expectedHard].sort(),
    extra: [],
    promotedPreferences: [],
    orderCorrect: false,
    byKind,
  };
}

export async function evaluateFixtureCase(
  item: HardCase,
  options: {
    referenceDate: string;
    timezone: 'Europe/Istanbul';
    config: JevConfig;
    transport: PlanEvalTransport;
    reader?: InputReader;
    live?: boolean;
  },
): Promise<PlanEvalRow> {
  const input: ParserInput = {
    utterance: item.message,
    language: 'tr',
    referenceDate: options.referenceDate,
    timezone: options.timezone,
    previousState: null,
  };

  options.transport.clearCallError();
  let actual: ActualOutcome;
  try {
    const result = await interpretSpanInput(input, {
      config: options.config,
      fetcher: options.transport.fetcher,
      reader: options.reader ?? 'fields',
    });
    if (result.status === 'accepted') {
      try {
        validatePlanState({
          version: 2,
          revision: 0,
          plan: result.resultingPlan,
          requests: [item.message],
        });
        validateSearchPlan(result.resultingPlan);
        actual = { outcome: 'search', plan: result.resultingPlan };
      } catch {
        actual = { outcome: 'decline', reason: 'unsupported_constraint' };
      }
    } else {
      actual = { outcome: 'decline', reason: result.reason };
    }
  } catch (error) {
    if (options.transport.lastCallError !== null || options.live) {
      const reason =
        options.transport.lastCallError ??
        (error instanceof Error ? error.message : 'provider error');
      return {
        id: item.id,
        actual: null,
        score: errorScoreForCase(item),
        error: reason,
      };
    }
    actual = { outcome: 'decline', reason: 'unavailable' };
  }

  return {
    id: item.id,
    actual,
    score: scoreCase(item, actual, options.referenceDate),
  };
}

export async function runPlanEval(options: {
  fixture: HardFixture;
  fixtureSha256: string;
  cacheDir: string;
  outputPath?: string;
  ledgerPath?: string;
  reader?: InputReader;
  live?: boolean;
  budget?: PlanEvalBudget;
  onlyIds?: string[];
  config?: JevConfig;
  network?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): Promise<PlanEvalOutput> {
  const live = Boolean(options.live);
  const reader = options.reader ?? 'fields';
  const config =
    options.config ??
    (live
      ? jevConfigFrom({
          TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
          TYPESAFE_MODEL: process.env.TYPESAFE_MODEL,
        })
      : {
          apiKey: 'offline-replay',
          model: process.env.TYPESAFE_MODEL ?? 'jev-1.13.0',
        });
  if (!config) {
    throw new Error('TYPESAFE_API_KEY is required for live plan evaluation.');
  }
  if (live) {
    validateBudget(options.budget);
  }

  const selectedCases = options.onlyIds?.length
    ? (() => {
        const byId = new Map(options.fixture.cases.map((c) => [c.id, c]));
        return options.onlyIds.map((id) => {
          const found = byId.get(id);
          if (!found) throw new Error(`Unknown fixture case id: ${id}`);
          return found;
        });
      })()
    : options.fixture.cases;

  const transport = new PlanEvalTransport({
    cacheDir: options.cacheDir,
    ledgerPath: options.ledgerPath,
    live,
    budget: options.budget,
    network: options.network,
    now: options.now,
    wait: options.wait,
  });

  const referenceDate = istanbulReferenceDate(options.fixture.referenceTime);
  const rows: PlanEvalRow[] = [];

  for (const item of selectedCases) {
    if (live && transport.halted) break;
    const row = await evaluateFixtureCase(item, {
      referenceDate,
      timezone: options.fixture.timezone,
      config,
      transport,
      reader,
      live,
    });
    rows.push(row);
    if (live && transport.halted) break;
  }

  // Error rows (cache miss, provider failure) are not scored as declines.
  const scored = summarize(
    rows.filter((row) => !row.error).map((row) => row.score),
  );
  const errorIds = rows.filter((row) => row.error).map((row) => row.id);
  const summary = {
    ...scored,
    errors: errorIds.length,
    failedIds: [...scored.failedIds, ...errorIds],
  };

  const output: PlanEvalOutput = {
    schemaVersion: 1,
    fixtureSha256: options.fixtureSha256,
    referenceTime: options.fixture.referenceTime,
    model: config.model,
    reader,
    mode: live ? 'live' : 'offline',
    rows,
    summary,
  };

  if (options.outputPath) {
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(
      options.outputPath,
      `${JSON.stringify(output, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  }

  return output;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      fixture: { type: 'string', default: 'fixtures/hard-v1.json' },
      cache: { type: 'string', default: 'work/plan-eval/cache' },
      output: { type: 'string' },
      reader: { type: 'string', default: 'fields' },
      live: { type: 'boolean', default: false },
      budget: { type: 'string' },
      only: { type: 'string' },
    },
  });

  const reader = inputReaderFrom({ INPUT_READER: values.reader });
  const rawFixture = await readFile(resolve(root, values.fixture!), 'utf8');
  const parsed = JSON.parse(rawFixture);
  const fixture = validateHardFixture('catalog' in parsed ? fromGoldenFixture(parsed) : parsed);
  const fixtureSha256 = sha256(rawFixture);

  const cacheDir = workPath(values.cache!);
  const outputPath = workPath(
    values.output ??
      `work/plan-eval/run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  const ledgerPath = workPath('work/plan-eval/budget-ledger.jsonl');
  const budget = values.budget
    ? (JSON.parse(
        await readFile(workPath(values.budget), 'utf8'),
      ) as PlanEvalBudget)
    : undefined;
  const onlyIds = values.only
    ? values.only
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : undefined;

  const output = await runPlanEval({
    fixture,
    fixtureSha256,
    cacheDir,
    outputPath,
    ledgerPath,
    reader,
    live: values.live,
    budget,
    onlyIds,
  });

  console.log(JSON.stringify(output.summary));
  process.exitCode = output.rows.some((row) => Boolean(row.error)) ? 1 : 0;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Plan evaluation failed.',
    );
    process.exitCode = 1;
  });
}
