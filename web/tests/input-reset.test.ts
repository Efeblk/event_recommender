import assert from 'node:assert/strict';
import test from 'node:test';
import { isStandaloneInputReset } from '../lib/input-reset.ts';

void test('standalone reset grammar accepts Turkish and English complete commands', () => {
  for (const message of [
    'Hepsini unut, baştan başlayalım.',
    'Forget everything, start over.',
    '  HEPSİNİ UNUT, BAŞTAN BAŞLAYALIM!  ',
    'Forget everything; START OVER!',
    'Hepsini unut. Baştan başlayalım.',
    'Her şeyi unut',
    'baştan başlayalım',
    'baştan başla',
    'ÖNCEKİ KOŞULLARI UNUT.',
    'SIFIRLA!',
    'reset',
    'start over',
    'Forget\n everything,\nstart over.',
  ]) {
    assert.equal(isStandaloneInputReset(message), true, message);
  }
});

void test('reset grammar rejects negation, partial resets and quoted titles', () => {
  for (const message of [
    "don't forget everything, start over.",
    'Do not forget everything.',
    'Forget everything? No, keep the budget.',
    'Hepsini unutma, baştan başlamayalım.',
    'Sıfırlama',
    'Tüm isteğe bağlı tercihleri sil, tarih kalsın.',
    'Forget every preference but keep the budget.',
    '"Hepsini unut, baştan başlayalım."',
    "'Forget everything, start over.'",
    '“Forget everything, start over.”',
    'Find a play titled "Forget everything, start over."',
    'Hepsini unut adlı oyunu arıyorum.',
    '',
    '...',
  ]) {
    assert.equal(isStandaloneInputReset(message), false, message);
  }
});

void test('reset with any new search or preserved condition stays on the interpreter path', () => {
  for (const message of [
    'Hepsini unut, baştan başlayalım. Yarın ücretsiz etkinlik.',
    'Forget everything, start over: free events tomorrow.',
    'Forget everything, start over. Under 700 TL.',
    'Hepsini unut, baştan başlayalım ama tarih aynı kalsın.',
    'Reset, Saturday theatre.',
    'Start over with a concert.',
    'Hepsini unut, baştan başlayalım. "Yarın"',
    'Start over, forget everything except accessibility.',
    'Please reset the budget.',
  ]) {
    assert.equal(isStandaloneInputReset(message), false, message);
  }
});
