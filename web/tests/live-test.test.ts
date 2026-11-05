import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  autoFlags,
  istanbulTime,
  mergeReview,
  percentile,
  reviewEntry,
  summarize,
} from '../scripts/live-test.mjs';

const run = promisify(execFile);
const read = async (path: string) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const fixture = await read('../fixtures/live-1r.json');

type Case = {
  id: string;
  language: string;
  message: string;
  outcome: string;
  hard?: string[];
};

await test('the live fixture has 60 new requests with checkable conditions', async () => {
  const cases: Case[] = fixture.cases;
  assert.equal(cases.length, 60);
  assert.equal(new Set(cases.map((c) => c.id)).size, 60);
  assert.equal(cases.filter((c) => c.language === 'tr').length, 40);
  assert.equal(cases.filter((c) => c.language === 'en').length, 20);
  for (const c of cases) {
    assert.ok(['search', 'decline'].includes(c.outcome), c.id);
    if (c.outcome === 'search')
      assert.ok(c.hard?.length, `${c.id} needs hard conditions`);
    else assert.equal(c.hard, undefined, c.id);
  }
  // New requests: none repeats the hard set or the golden set.
  const hard = await read('../fixtures/hard-v1.json');
  const golden = await read('../fixtures/golden-v1.json');
  const old = new Set(
    [...hard.cases, ...(golden.cases ?? golden)]
      .map((c: { message?: string }) => c.message?.toLowerCase())
      .filter(Boolean),
  );
  for (const c of cases) assert.ok(!old.has(c.message.toLowerCase()), c.id);
});

const event = {
  id: 'e1',
  title: 'Caz Gecesi',
  startsAt: '2026-11-06T17:30:00.000Z',
  venue: 'Salon',
  district: 'Beşiktaş',
  city: 'İstanbul',
  price: 400,
  currency: 'TRY',
  category: 'Konser',
  availability: 'available',
  source: 'bubilet',
  url: 'https://www.bubilet.com.tr/istanbul/etkinlik/caz',
  offers: [{ source: 'bubilet', url: 'https://x', price: 400 }],
};
const searchCase = fixture.cases[0];
const response = {
  sentAt: '2026-11-05T10:00:00.000Z',
  elapsedMs: 1200,
  httpStatus: 200,
  body: { status: 'results', notice: null, recommendations: [{ event }] },
};

await test('cards show the Istanbul date with its weekday', () => {
  assert.equal(
    istanbulTime('2026-11-06T17:30:00.000Z'),
    'Fri 2026-11-06 20:30',
  );
  const entry = reviewEntry(searchCase, response);
  assert.equal(entry.cards[0].startsLocal, 'Fri 2026-11-06 20:30');
  assert.deepEqual(entry.hard, searchCase.hard);
  assert.equal(entry.verdict, null);
});

await test('auto flags point the reviewer at likely problems', () => {
  const decline = fixture.cases.find((c: Case) => c.outcome === 'decline');
  assert.deepEqual(autoFlags(decline, response), [
    'decline-expected-but-results',
  ]);
  assert.deepEqual(
    autoFlags(searchCase, {
      httpStatus: 200,
      body: {
        status: 'results',
        notice: 'Anlamsal arama şu anda yoğun; kelime araması kullanılıyor.',
        recommendations: [{ event }, { event }],
      },
    }),
    ['word-matching-fallback', 'duplicate-card-id'],
  );
  assert.deepEqual(autoFlags(searchCase, undefined), ['http-missing']);
});

await test('rebuilding the review keeps verdicts and card checks', () => {
  const first = reviewEntry(searchCase, response);
  const reviewed = {
    ...first,
    verdict: 'GOOD',
    note: 'all fine',
    cards: [{ ...first.cards[0], check: 'ok', note: 'jazz' }],
  };
  const [merged] = mergeReview([reviewed], [reviewEntry(searchCase, response)]);
  assert.equal(merged.verdict, 'GOOD');
  assert.equal(merged.cards[0].check, 'ok');
  assert.equal(merged.cards[0].note, 'jazz');
});

await test('summary accepts only a fully reviewed run without blocking BAD results', () => {
  const ok = { ...reviewEntry(searchCase, response), verdict: 'GOOD' };
  ok.cards = ok.cards.map((card: object) => ({ ...card, check: 'ok' }));
  assert.equal(summarize([ok]).accepted, true);
  const unchecked = summarize([reviewEntry(searchCase, response)]);
  assert.equal(unchecked.accepted, false);
  assert.match(unchecked.problems.join('\n'), /no verdict/);
  const blocking = summarize([{ ...ok, verdict: 'BAD', cause: 'parsing' }]);
  assert.deepEqual(blocking.blocking, ['l01: parsing']);
  assert.equal(blocking.accepted, false);
  assert.equal(
    summarize([{ ...ok, verdict: 'BAD', cause: 'catalog-gap' }]).accepted,
    true,
  );
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
});

await test('run sends each case once, stops at a rate limit and resumes', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push(JSON.parse(body).message);
      res.setHeader('Content-Type', 'application/json');
      if (seen.length === 3) {
        res.statusCode = 429;
        res.end(JSON.stringify({ code: 'rate_limited', retryAfter: 60 }));
        return;
      }
      res.end(
        JSON.stringify({
          status: 'results',
          notice: null,
          recommendations: [{ event }],
        }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  const dir = await mkdtemp(join(tmpdir(), 'live-test-'));
  const fixturePath = join(dir, 'fixture.json');
  await writeFile(
    fixturePath,
    JSON.stringify({ ...fixture, cases: fixture.cases.slice(0, 5) }),
  );
  const script = new URL('../scripts/live-test.mjs', import.meta.url).pathname;
  const args = (max: number) => [
    script,
    'run',
    '--base-url',
    `http://127.0.0.1:${port}`,
    '--max-requests',
    String(max),
    '--interval-seconds',
    '0',
    '--fixture',
    fixturePath,
    '--out',
    join(dir, 'out'),
  ];
  try {
    const first = await run(process.execPath, args(10));
    assert.match(first.stdout, /Rate limited/);
    assert.equal(seen.length, 3, 'no retry after the rate limit');
    assert.equal((await readdir(join(dir, 'out', 'responses'))).length, 2);
    // The rate-limited case made no search: the next run sends it first.
    const second = await run(process.execPath, args(1));
    assert.match(second.stdout, /max-requests 1/);
    assert.equal(seen.length, 4);
    assert.equal(seen[3], seen[2]);
    assert.equal((await readdir(join(dir, 'out', 'responses'))).length, 3);
    const review = JSON.parse(
      await readFile(join(dir, 'out', 'review.json'), 'utf8'),
    );
    assert.equal(review.length, 5);
    assert.equal(review[2].status, 'results');
    assert.equal(review[3].httpStatus, null);
    await assert.rejects(
      run(process.execPath, [script, 'summary', '--out', join(dir, 'out')]),
      (error: { code: number; stdout: string }) =>
        error.code === 1 && /not sent/.test(error.stdout),
    );
  } finally {
    server.close();
  }
});
