import assert from 'node:assert/strict';
import test from 'node:test';
import { categoryIntent } from '../lib/intent.ts';

void test('fallback recognizes each explicit catalog category in Turkish and English', () => {
  const cases = [
    ['atölye istiyorum', 'Workshop'], ['exhibition please', 'Sergi'],
    ['festival olsun', 'Festival'], ['sports event please', 'Spor'],
    ['sinema istiyorum', 'Sinema'], ['söyleşi olsun', 'Söyleşi'],
    ['dans gösterisi istiyorum', 'Dans'], ['stage show please', 'Gösteri'],
    ['eğitim etkinliği istiyorum', 'Eğitim'], ['guided tour please', 'Gezi'],
    ['müze istiyorum', 'Müze'], ['other category please', 'Diğer'],
  ] as const;
  for (const [message, category] of cases)
    assert.ok(categoryIntent(message).requestedCategories.includes(category), message);
  assert.deepEqual(categoryIntent('dans gösterisi istiyorum').requestedCategories, ['Dans']);
});

void test('display and merge wording does not become a hard Gösteri category', () => {
  const intent = categoryIntent('Aynı gösteri birden fazla bilet sitesinde varsa tek kartta göster; 3 Ekim Kadıköy’de stand-up, en çok 700 TL.');
  assert.deepEqual(intent.requestedCategories, ['Stand-up']);
  assert.deepEqual(intent.excludedCategories, []);
});

void test('generic requests and permissive workshop examples do not create hard categories', () => {
  for (const message of ['etkinlik öner', 'show me events', 'bir aktivite olsun', 'workshop olabilir', 'an atelier could be nice'])
    assert.deepEqual(categoryIntent(message).requestedCategories, [], message);
});

void test('new category exclusions support coordinated Turkish and English lists', () => {
  const turkish = categoryIntent('workshop veya sergi olmasın, festival olsun');
  assert.deepEqual(new Set(turkish.excludedCategories), new Set(['Workshop', 'Sergi']));
  assert.deepEqual(turkish.requestedCategories, ['Festival']);

  const english = categoryIntent('no museums or guided tours, cinema please');
  assert.deepEqual(new Set(english.excludedCategories), new Set(['Müze', 'Gezi']));
  assert.deepEqual(english.requestedCategories, ['Sinema']);
});
