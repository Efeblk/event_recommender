import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './golden-v1.ts';

export interface GoldenBudget {
  scope: 'phase-1';
  jevCapUsd: number;
  /** null records explicit user approval of unrestricted Voyage usage. */
  voyageCapUsd: number | null;
  approvedBy: string;
  approvedAt: string;
}
interface Reservation {
  key: string;
  provider: string;
  reservedUsd: number;
  at: string;
}
interface Usage {
  key: string;
  tokens: number;
  estimatedUsd: number;
  reservedUsd: number;
}
interface TransportOptions {
  directory: string;
  catalogSha256: string;
  referenceTime: string;
  budgetDirectory?: string;
  live?: boolean;
  budget?: GoldenBudget;
  network?: typeof fetch;
}
export class GoldenTransport {
  hits = 0;
  paidCalls = 0;
  errors: string[] = [];
  private inProgress = false;
  private options: TransportOptions;
  constructor(options: TransportOptions) {
    this.options = options;
  }

  fetcher(requestText: string): typeof fetch {
    return async (url, init) => {
      try {
        return await this.request(
          requestText,
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url,
          init,
        );
      } catch (error) {
        // Messages below contain no provider response, input body or credential.
        const message =
          error instanceof GoldenCacheError
            ? error.message
            : 'Golden provider attempt failed; no automatic retry.';
        this.errors.push(message);
        throw new GoldenCacheError(message);
      }
    };
  }

  private async request(requestText: string, url: string, init?: RequestInit) {
    if (
      ![
        'https://api.typesafe.ai/v1/systemone',
        'https://api.voyageai.com/v1/embeddings',
      ].includes(url) ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string'
    )
      throw new GoldenCacheError('Unsupported golden provider request.');
    const body = init.body;
    const key = sha256(
      JSON.stringify({
        version: 1,
        catalog: this.options.catalogSha256,
        now: this.options.referenceTime,
        requestText,
        url,
        body,
      }),
    );
    const file = join(this.options.directory, `${key}.json`);
    let cached: string | undefined;
    try {
      cached = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (cached !== undefined) {
      const entry = JSON.parse(cached) as {
        key: string;
        raw: string;
        sha256: string;
      };
      if (
        entry.key !== key ||
        typeof entry.raw !== 'string' ||
        sha256(entry.raw) !== entry.sha256
      )
        throw new GoldenCacheError('Corrupt golden provider cache.');
      this.hits++;
      return new Response(entry.raw, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!this.options.live)
      throw new GoldenCacheError(`Offline cache miss: ${key}`);
    if (this.errors.length)
      throw new GoldenCacheError(
        'A previous provider attempt failed; stop live calls and inspect the saved run.',
      );
    const budget = this.options.budget;
    if (
      budget?.scope !== 'phase-1' ||
      !Number.isFinite(budget.jevCapUsd) ||
      budget.jevCapUsd <= 0 ||
      !(
        budget.voyageCapUsd === null ||
        (Number.isFinite(budget.voyageCapUsd) && budget.voyageCapUsd > 0)
      ) ||
      !budget.approvedBy.trim() ||
      !Number.isFinite(Date.parse(budget.approvedAt))
    )
      throw new GoldenCacheError('User-approved Phase 1 budget is required.');
    const voyage = url.includes('voyageai');
    const payload = JSON.parse(body) as { input_type?: string; model?: string };
    if (
      voyage &&
      (payload.input_type !== 'query' || payload.model !== 'voyage-4-large')
    )
      throw new GoldenCacheError(
        'Golden runner only embeds queries with voyage-4-large.',
      );
    if (Buffer.byteLength(body) > 100_000)
      throw new GoldenCacheError('Golden provider request exceeds limit.');
    if (this.inProgress)
      throw new GoldenCacheError('Golden requests must run serially.');
    await mkdir(this.options.directory, { recursive: true });
    const budgetDirectory =
      this.options.budgetDirectory ?? this.options.directory;
    await mkdir(budgetDirectory, { recursive: true });
    // File lock and write-ahead reservations also guard process crashes and reruns.
    let lock;
    try {
      lock = await open(join(budgetDirectory, 'live.lock'), 'wx', 0o600);
    } catch {
      throw new GoldenCacheError(
        'Golden live lock exists; inspect the previous attempt before continuing.',
      );
    }
    this.inProgress = true;
    try {
      const ledgerFile = join(budgetDirectory, 'budget-ledger.jsonl');
      let halted = false;
      try {
        await readFile(join(budgetDirectory, 'halted.json'));
        halted = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (halted)
        throw new GoldenCacheError(
          'Phase 1 golden accounting is halted; inspect the saved attempt.',
        );
      let ledger = '';
      try {
        ledger = await readFile(ledgerFile, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const entries = ledger
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Reservation);
      if (
        entries.some(
          (entry) =>
            !/^[a-f0-9]{64}$/.test(entry.key) ||
            !Number.isFinite(entry.reservedUsd) ||
            entry.reservedUsd <= 0,
        )
      )
        throw new GoldenCacheError('Invalid golden budget ledger.');
      if (entries.some((entry) => entry.key === key))
        throw new GoldenCacheError(
          'An uncached attempt already has a reservation; no automatic retry.',
        );
      const reservedUsd = voyage ? 0.01 : 0.02;
      let usageRaw = '';
      try {
        usageRaw = await readFile(join(budgetDirectory, 'usage.jsonl'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const usages = usageRaw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Usage);
      const settled = new Map(
        usages.map((usage) => [usage.key, usage.estimatedUsd]),
      );
      if (
        settled.size !== usages.length ||
        usages.some(
          (usage) =>
            !Number.isFinite(usage.estimatedUsd) ||
            usage.estimatedUsd < 0 ||
            !entries.some((entry) => entry.key === usage.key),
        )
      )
        throw new GoldenCacheError('Invalid golden usage ledger.');
      const cap = voyage ? budget.voyageCapUsd : budget.jevCapUsd;
      const provider = voyage ? 'voyage' : 'typesafe';
      if (
        cap !== null &&
        entries
          .filter((entry) => entry.provider === provider)
          .reduce(
            (sum, entry) => sum + (settled.get(entry.key) ?? entry.reservedUsd),
            0,
          ) +
          reservedUsd >
          cap + 1e-9
      )
        throw new GoldenCacheError('Phase 1 golden budget reached.');
      // Keep a failed or interrupted reservation charged at its full envelope.
      const ledgerHandle = await open(ledgerFile, 'a', 0o600);
      try {
        await ledgerHandle.write(
          `${JSON.stringify({ key, provider: voyage ? 'voyage' : 'typesafe', reservedUsd, at: new Date().toISOString() })}\n`,
        );
        await ledgerHandle.sync();
      } finally {
        await ledgerHandle.close();
      }
      this.paidCalls++;
      const response = await (this.options.network ?? fetch)(url, init);
      if (!response.ok) {
        await response.body?.cancel();
        throw new GoldenCacheError(
          `Golden provider HTTP ${response.status}; no automatic retry.`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new GoldenCacheError('Golden provider response is missing.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4 * 1024 * 1024)
            throw new GoldenCacheError(
              'Golden provider response exceeds limit.',
            );
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const authorization = new Headers(init.headers)
        .get('Authorization')
        ?.replace(/^Bearer\s+/i, '');
      if (
        authorization &&
        (raw.includes(authorization) ||
          raw.includes(JSON.stringify(authorization).slice(1, -1)))
      )
        throw new GoldenCacheError('Credential reflection suppressed.');
      const parsed = JSON.parse(raw) as {
        usage?: { input_tokens?: number; total_tokens?: number };
      };
      const tokens = voyage
        ? parsed.usage?.total_tokens
        : parsed.usage?.input_tokens;
      if (!Number.isSafeInteger(tokens) || tokens! < 0)
        throw new GoldenCacheError('Golden token accounting is missing.');
      const estimatedUsd = (tokens! * (voyage ? 0.12 : 0.042)) / 1_000_000;
      const usageHandle = await open(
        join(budgetDirectory, 'usage.jsonl'),
        'a',
        0o600,
      );
      try {
        await usageHandle.write(
          `${JSON.stringify({ key, tokens, estimatedUsd, reservedUsd })}\n`,
        );
        await usageHandle.sync();
      } finally {
        await usageHandle.close();
      }
      if (estimatedUsd > reservedUsd) {
        await writeFile(
          join(budgetDirectory, 'halted.json'),
          JSON.stringify({
            key,
            reason: 'usage exceeded reservation',
            estimatedUsd,
            reservedUsd,
          }),
          { flag: 'wx', mode: 0o600 },
        );
        throw new GoldenCacheError(
          'Provider usage exceeded the reservation; stop and inspect.',
        );
      }
      await writeFile(
        file,
        JSON.stringify({ key, raw, sha256: sha256(raw) }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      return new Response(raw, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      this.inProgress = false;
      // Successful cleanup does not erase a paid-attempt reservation.
      await lock.close();
      const { unlink } = await import('node:fs/promises');
      await unlink(join(budgetDirectory, 'live.lock'));
    }
  }
}
class GoldenCacheError extends Error {}
