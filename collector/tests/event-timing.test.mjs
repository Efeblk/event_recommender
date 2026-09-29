import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { extract } from '../adapters.mjs';

const checkedAt = new Date('2026-09-28T16:00:00.000Z');

function page({ code, title, info, times, flexible = false, validFrom = null, validThrough = null, category = 'Müze' }) {
  const performances = times.map((performanceDate, index) => ({
    eventCode: code,
    performanceCode: String(index + 1).padStart(3, '0'),
    eventName: title,
    venueName: `${title} Mekanı`,
    venueCity: 'İstanbul',
    performanceDate,
    status: 's01_onsale',
    minPrice: 10000,
    active: true,
  }));
  const state = {
    performances: {
      b: { status: 'SUCCESS', data: performances },
      u: `https://www.biletix.com/wbtxapi/api/v1/bxcached/event/getPerformanceList/${code}/INTERNET/tr`,
    },
    detail: {
      b: { status: 'SUCCESS', data: {
        eventCode: code,
        eventName: title,
        eventDescription: title,
        info,
        eventRules: '',
        venueTown: 'BEYOĞLU',
        eventCategoryCode: category,
        subCategory: category,
        flexibleTimeEventCheck: flexible,
        startShowDate: validFrom,
        endShowDate: validThrough,
      } },
      u: `https://www.biletix.com/wbtxapi/api/v1/bxcached/event/getEventDetail/${code}/INTERNET/tr`,
    },
  };
  return load(`<script id="ng-state">${JSON.stringify(state)}</script>`);
}

async function events(input) {
  return extract(
    page(input),
    'biletix',
    `https://www.biletix.com/etkinlik/${input.code}/ISTANBUL/tr`,
    null,
    checkedAt,
  );
}

test('Dialog sessions retain exact starts and carry explicit timed-session evidence', async () => {
  const rows = await events({
    code: '5Q548',
    title: 'İstanbul Diyalog Müzesi | Sessizlik Deneyimi',
    info: 'Seanslar 10 bilet ile sınırlıdır. Seans saatinizden 15 dakika önce geliniz; geç kalınca bilet geçersizdir.',
    times: [1790753400000, 1790755200000, 1790757000000],
  });
  assert.deepEqual(rows.map((row) => row.startsAt), [
    '2026-09-30T07:30:00.000Z',
    '2026-09-30T08:00:00.000Z',
    '2026-09-30T08:30:00.000Z',
  ]);
  assert.ok(rows.every((row) => row.attendanceTiming?.kind === 'timed_session'));
});

test('Rahmi Koç flexible admission stores exact validity boundaries, not opening hours', async () => {
  const [row] = await events({
    code: '5RMK9',
    title: 'Rahmi Mustafa Koç Müzesi Giriş',
    info: 'Biletler 1-30 Eylül arasında geçerlidir. Müze 10:00-17:00 arası açıktır.',
    times: [1790776800000],
    flexible: true,
    validFrom: 1788246000000,
    validThrough: 1790776800000,
  });
  assert.equal(row.startsAt, '2026-09-30T14:00:00.000Z');
  assert.deepEqual(row.attendanceTiming, {
    kind: 'admission_window',
    evidence: 'provider_flexible_window',
    validFrom: '2026-09-01T07:00:00.000Z',
    validThrough: '2026-09-30T14:00:00.000Z',
  });
});

test('museum opening-like timestamps remain unknown without explicit flexible evidence', async () => {
  const [[modern], [frida]] = await Promise.all([
    events({
      code: '5IM01', title: 'İstanbul Modern - Müze Girişi',
      info: 'Müze girişleri kapanıştan 30 dakika önce sona erer.', times: [1790751600000],
    }),
    events({
      code: '5MTRY', title: 'Frida Kahlonun Günlükleri Sergisi', category: 'Sergi',
      info: 'Sergi saatleri 11:00-20:00. Bilet alındığı gün ve seans için geçerlidir.', times: [1790755200000],
    }),
  ]);
  assert.deepEqual(modern.attendanceTiming, { kind: 'unknown', evidence: 'insufficient_source_evidence' });
  assert.deepEqual(frida.attendanceTiming, { kind: 'unknown', evidence: 'insufficient_source_evidence' });
});

test('invalid flexible bounds stay unknown and unrelated records remain unclassified', async () => {
  const [[museum], [malformedConcert], [concert]] = await Promise.all([
    events({
      code: 'BAD01', title: 'Örnek Müze Girişi', info: 'Ziyaret saatleri 10:00-18:00.',
      times: [1790751600000], flexible: true, validFrom: 1790776800000, validThrough: 1788246000000,
    }),
    events({
      code: 'BAD02', title: 'Esnek Biletli Konser', category: 'Konser', info: 'Esnek giriş.',
      times: [1790787600000], flexible: true, validFrom: null, validThrough: null,
    }),
    events({
      code: 'MUS01', title: 'Örnek Konser', category: 'Konser', info: 'Saat 20:00.', times: [1790787600000],
    }),
  ]);
  assert.equal(museum.attendanceTiming?.kind, 'unknown');
  assert.equal(malformedConcert.attendanceTiming?.kind, 'unknown');
  assert.equal('attendanceTiming' in concert, false);
});
