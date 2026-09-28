import test from 'node:test';
import assert from 'node:assert/strict';
import { detailUrl } from '../adapters.mjs';
import { followDetailRedirects, nextDetailRedirect } from '../redirects.mjs';

const initial = 'https://biletinial.com/tr-tr/sinema/eski-film';
const next = (overrides = {}) => nextDetailRedirect({
  initialUrl: initial,
  currentUrl: initial,
  location: '/tr-tr/sinema/yeni-film',
  source: 'biletinial',
  detailUrl,
  visited: new Set([initial]),
  redirects: 0,
  ...overrides,
});

test('accepts a same-source canonical cinema detail while preserving caller identity', () => {
  assert.equal(next(), 'https://biletinial.com/tr-tr/sinema/yeni-film');
  assert.equal(initial, 'https://biletinial.com/tr-tr/sinema/eski-film');
});

test('rejects redirects to vanished pages, another source, and non-HTTPS targets', () => {
  assert.throws(() => next({ location: '/404' }), /redirect_not_detail/);
  assert.throws(() => next({ location: 'https://www.biletix.com/etkinlik/ABC/ISTANBUL/tr' }), /redirect_cross_origin/);
  assert.throws(() => next({ location: 'http://biletinial.com/tr-tr/sinema/yeni-film' }), /redirect_cross_origin/);
});

test('rejects redirect loops and the fourth hop', () => {
  const target = 'https://biletinial.com/tr-tr/sinema/yeni-film';
  assert.throws(() => next({ visited: new Set([initial, target]) }), /redirect_loop/);
  assert.throws(() => next({ redirects: 3 }), /redirect_limit/);
});

test('Biletix homepage redirects stay visible as invalid detail failures', () => {
  const original = 'https://www.biletix.com/etkinlik/0E007/ISTANBUL/tr';
  assert.throws(() => next({
    initialUrl: original,
    currentUrl: original,
    location: 'https://www.biletix.com',
    source: 'biletix',
    visited: new Set([original]),
  }), /redirect_not_detail/);
});

test('invalid redirect-chain failures retain their source HTTP status', async () => {
  let cancelled = 0;
  await assert.rejects(() => followDetailRedirects({
    initialUrl: initial,
    source: 'biletinial',
    detailUrl,
    request: async () => ({
      status: 301,
      headers: new Headers({ location: '/404' }),
      body: { cancel: async () => { cancelled += 1; throw new Error('cleanup_failed'); } },
    }),
  }), /http_301:redirect_not_detail/);
  assert.equal(cancelled, 1);
});

test('follows a canonical cinema redirect and returns a target 404 unchanged', async () => {
  let cancelled = 0;
  const responses = new Map([
    [initial, { status: 301, headers: new Headers({ location: '/tr-tr/sinema/yeni-film' }), body: { cancel: async () => { cancelled += 1; } } }],
    ['https://biletinial.com/tr-tr/sinema/yeni-film', { status: 404, headers: new Headers(), body: null }],
  ]);
  const result = await followDetailRedirects({
    initialUrl: initial,
    source: 'biletinial',
    request: async (url) => responses.get(url),
    detailUrl,
  });
  assert.equal(result.finalUrl, 'https://biletinial.com/tr-tr/sinema/yeni-film');
  assert.equal(result.redirects, 1);
  assert.equal(result.response.status, 404);
  assert.equal(cancelled, 1);
});

test('every redirect target is passed through the caller robots gate', async () => {
  const calls = [];
  await assert.rejects(() => followDetailRedirects({
    initialUrl: initial,
    source: 'biletinial',
    detailUrl,
    request: async (url) => {
      calls.push(url);
      if (url !== initial) throw new Error('robots_disallowed');
      return { status: 301, headers: new Headers({ location: '/tr-tr/sinema/yeni-film' }), body: null };
    },
  }), /robots_disallowed/);
  assert.deepEqual(calls, [initial, 'https://biletinial.com/tr-tr/sinema/yeni-film']);
});

test('Biletix redirects may change an SEO title but not the stable event code', () => {
  const original = 'https://www.biletix.com/etkinlik/ABC/ISTANBUL/tr';
  assert.equal(next({
    initialUrl: original,
    currentUrl: original,
    location: '/etkinlik/ABC/ISTANBUL/tr/yeni-baslik',
    source: 'biletix',
    visited: new Set([original]),
  }), 'https://www.biletix.com/etkinlik/ABC/ISTANBUL/tr/yeni-baslik');
  assert.throws(() => next({
    initialUrl: original,
    currentUrl: original,
    location: '/etkinlik/XYZ/ISTANBUL/tr/baska',
    source: 'biletix',
    visited: new Set([original]),
  }), /redirect_identity_changed/);
});
