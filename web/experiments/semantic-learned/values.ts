import type { ParserInput, BudgetBasis } from '../semantic-grammar/contract.ts';

export interface SourceToken { id: string; start: number; end: number; text: string }
export interface ExactValue {
  id: string; kind: 'number' | 'date' | 'time' | 'party_delta';
  refs: string[]; text: string; number?: number; from?: string; to?: string;
  target?: string;
}
export interface PreparedInput {
  utterance: string; tokens: SourceToken[]; values: ExactValue[];
  referenceDate: string; previousRevision: number | null;
}
const words: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20,
  sıfır: 0, bir: 1, iki: 2, üç: 3, dört: 4, beş: 5, altı: 6, yedi: 7,
  sekiz: 8, dokuz: 9, on: 10, yirmi: 20, otuz: 30, kırk: 40, elli: 50,
  altmış: 60, yetmiş: 70, seksen: 80, doksan: 90, yüz: 100, bin: 1000,
};
export const lower = (text: string) => text.toLocaleLowerCase('tr-TR');
const locations = ['Kadıköy', 'Beşiktaş', 'Şişli', 'Üsküdar', 'Beyoğlu', 'Bakırköy', 'Fatih', 'Sarıyer', 'Ataşehir', 'Maltepe', 'Taksim', 'Moda', 'Cihangir', 'Nişantaşı'];
const fold = (text: string) => lower(text).replaceAll('ı', 'i').normalize('NFD').replace(/\p{M}/gu, '');
export function resolveLocation(text: string): { name: string; precision: 'district' | 'neighborhood' } | undefined {
  const normalized = fold(text.trim()).replace(/['’](?:da|de|ta|te|daki|deki)$/u, '');
  const index = locations.findIndex(name => fold(name) === normalized);
  return index < 0 ? undefined : { name: locations[index], precision: index < 10 ? 'district' : 'neighborhood' };
}
function day(iso: string, delta = 0) {
  const value = new Date(`${iso}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso) || !Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== iso) throw new Error('invalid reference date');
  value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}
export function explicitBases(text: string): BudgetBasis[] {
  const value = lower(text); const result: BudgetBasis[] = [];
  if (/\bper\s+person\b|kişi\s*başı(?:na)?|kişi\s+başına/u.test(value)) result.push('per_person');
  if (/\bper\s+ticket\b|bilet\s*başı(?:na)?|bilet\s+başına/u.test(value)) result.push('per_ticket');
  if (/\b(?:total|altogether|combined)\b|toplam|hepimiz\s+için|grup\s+için/u.test(value)) result.push('group_total');
  return result;
}
export function prepareInput(input: ParserInput): PreparedInput {
  if (input.timezone !== 'Europe/Istanbul' || input.utterance.length > 2048) throw new Error('input bounds/timezone');
  const referenceDate = day(input.referenceDate);
  const tokens: SourceToken[] = [];
  for (const match of input.utterance.matchAll(/[\p{L}\p{N}]+(?:[.,:]\p{N}+)*\p{L}*|[^\s\p{L}\p{N}]/gu)) {
    tokens.push({ id: `t${tokens.length}`, start: match.index!, end: match.index! + match[0].length, text: match[0] });
  }
  if (tokens.length > 160) throw new Error('token bound');
  const values: ExactValue[] = [];
  const add = (start: number, end: number, data: Omit<ExactValue, 'id' | 'refs' | 'text'>) => {
    const refs = tokens.filter(t => t.start < end && t.end > start).map(t => t.id);
    values.push({ id: `v${values.length}`, refs, text: input.utterance.slice(start, end), ...data });
  };
  for (const token of tokens) {
    // Attached TRY suffixes retain the complete original token as evidence.
    const word = lower(token.text).replace(/^(\d+(?:[.,]\d+)*)(?:tl|try|lira|lirası)$/u, '$1');
    let number = words[word];
    if (/^\d+(?:[.,]\d+)*$/u.test(word)) {
      if (/^\d+$/u.test(word)) number = Number(word);
      else if (input.language === 'tr' && /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/u.test(word)) number = Number(word.replaceAll('.', '').replace(',', '.'));
      else if (input.language === 'en' && /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/u.test(word)) number = Number(word.replaceAll(',', ''));
      else if (/^\d+[.,]\d{1,2}$/u.test(word)) number = Number(word.replace(',', '.'));
      else number = NaN;
    }
    if (number !== undefined && Number.isFinite(number)) add(token.start, token.end, { kind: 'number', number });
  }
  const scan = (pattern: RegExp, callback: (m: RegExpExecArray) => Omit<ExactValue, 'id' | 'refs' | 'text'> | null) => {
    for (const match of input.utterance.matchAll(pattern)) {
      const data = callback(match); if (data) add(match.index!, match.index! + match[0].length, data);
    }
  };
  scan(/\b\d{4}-\d{2}-\d{2}\b/gu, m => { try { const from = day(m[0]); return { kind: 'date', from, to: from }; } catch { return null; } });
  scan(/\b(today|tomorrow)\b|bugün|yarın/giu, m => { const from = day(referenceDate, ['tomorrow', 'yarın'].includes(lower(m[0])) ? 1 : 0); return { kind: 'date', from, to: from }; });
  scan(/\b(?:this\s+weekend|next\s+week)\b|bu\s+hafta\s+sonu|gelecek\s+hafta|önümüzdeki\s+hafta/giu, m => {
    const weekday = new Date(`${referenceDate}T12:00:00Z`).getUTCDay();
    const nextWeek = /next|gelecek|önümüzdeki/iu.test(m[0]);
    const from = nextWeek ? day(referenceDate, (8 - weekday) % 7 || 7) : day(referenceDate, weekday === 0 ? 0 : Math.max(0, 6 - weekday));
    return { kind: 'date', from, to: day(from, nextWeek ? 6 : weekday === 0 ? 0 : 1) };
  });
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const weekdaysTr = ['pazar', 'pazartesi', 'salı', 'çarşamba', 'perşembe', 'cuma', 'cumartesi'];
  scan(/\b(?:this\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|(?:bu\s+)?(?:pazartesi|cumartesi|çarşamba|perşembe|pazar|salı|cuma)(?![\p{L}])/giu, m => {
    const name = lower(m[0]).replace(/^(?:this|bu)\s+/u, '');
    const index = Math.max(weekdays.indexOf(name), weekdaysTr.indexOf(name));
    const current = new Date(`${referenceDate}T12:00:00Z`).getUTCDay();
    const delta = /^(?:this|bu)\s/iu.test(m[0]) ? ((index + 6) % 7) - ((current + 6) % 7) : (index - current + 7) % 7;
    const from = day(referenceDate, delta); return { kind: 'date', from, to: from };
  });
  scan(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/giu, m => {
    let hour = Number(m[1] ?? m[4]); const minute = Number(m[2] ?? m[5] ?? 0);
    if (m[3]) { if (hour < 1 || hour > 12 || minute > 59) return null; hour = hour % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0); }
    const from = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return { kind: 'time', from, to: from };
  });
  // Arithmetic is permitted only against one explicit prior party atom.
  const priorParty = input.previousState?.plan.hard.type === 'all' ? input.previousState.plan.hard.children.filter(c => c.type === 'atom' && c.atom.kind === 'party') : [];
  if (priorParty.length === 1) {
    const prior = priorParty[0];
    if (prior.type === 'atom' && prior.atom.kind === 'party' && prior.id) {
      scan(/\b(\d+|one|two|three)\s+(?:people\s+|person\s+)?(less|fewer|more)\b|(\d+|bir|iki|üç)\s+kişi\s+(eksik|az|fazla)/giu, m => {
        const literal = lower(m[1] ?? m[3]); const delta = /^\d+$/u.test(literal) ? Number(literal) : words[literal];
        const number = prior.atom.kind === 'party' ? prior.atom.count + (/more|fazla/u.test(m[2] ?? m[4]) ? delta : -delta) : NaN;
        return Number.isInteger(number) && number > 0 ? { kind: 'party_delta', number, target: prior.id } : null;
      });
    }
  }
  return { utterance: input.utterance, tokens, values, referenceDate, previousRevision: input.previousState?.revision ?? null };
}
