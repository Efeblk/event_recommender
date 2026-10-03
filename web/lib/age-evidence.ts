import { normalize } from './search.ts';
import type { EventRecord } from './types.ts';
import type { RequirementStatus } from './requirements.ts';

/** Source admission/audience rules, never performer biographies or fame. */
export function checkAgeEvidence(event: EventRecord, years: number): {
  status: RequirementStatus; evidence: string[];
} {
  const rules: Array<{ min: number; max: number; evidence: string }> = [];
  const uncertain: string[] = [];
  const text = normalize(event.description);
  const add = (match: RegExpMatchArray, min: number, max = 120) => {
    const start = match.index ?? 0;
    const before = text.slice(Math.max(0, start - 24), start);
    const after = text.slice(start + match[0].length).split(/[.!?;\n]/u)[0].slice(0, 60);
    if (/(?:\b(?:not|no|without)\s+|\bnot\s+(?:suitable|recommended)\s+for\s*)$/u.test(before)
      || /\b(?:(?:(?:uygun|gecerli) )?degil(?:dir)?|uygun olmayan|onerilmez|giremez|kabul edilmez|does not apply|not (?:suitable|allowed))\b/u.test(after)) {
      uncertain.push(match[0]); return;
    }
    if (min <= max && min >= 0 && max <= 120)
      rules.push({ min, max, evidence: match[0].slice(0, 240) });
  };
  // Explicit policy labels, including the common provider "Yaş sınırı: 6+".
  for (const m of text.matchAll(/\b(?:yas (?:siniri|araligi|grubu)|age (?:limit|range|restriction)|ages?)\s*[:：-]?\s*(\d{1,3})\s*[-–]\s*(\d{1,3})(?:\s*(?:yas|years?))?\b/gu)) add(m, Number(m[1]), Number(m[2]));
  for (const m of text.matchAll(/\b(?:yas (?:siniri|araligi|grubu)|age (?:limit|restriction)|ages?)\s*[:：-]?\s*(\d{1,3})\s*(?:\+|ve uzeri|and (?:over|up)|or older)/gu)) add(m, Number(m[1]));
  for (const m of text.matchAll(/(?<!\d)\+?(\d{1,3})\s*\+?\s*yas siniri(?: vardir| bulunmaktadir)?\b/gu)) add(m, Number(m[1]));
  // A stated child/attendee age range or a stated lower-age suitability rule.
  for (const m of text.matchAll(/\b(\d{1,3})\s*[-–]\s*(\d{1,3})\s*yas(?:\s+arasi)?\s+(?:cocuk(?:lar|lara)?|izleyici(?:ler|lere)?|katilimci(?:lar|lara)?)\s+(?:icin(?:dir)?|yonelik(?:tir)?|uygun(?:dur)?|onerilir|katilabilir)/gu)) add(m, Number(m[1]), Number(m[2]));
  for (const m of text.matchAll(/\b(\d{1,3})\s*(?:yas\s*(?:ve uzeri|ustu)|\+)\s+(?:(?:olan|tum)\s+)?(?:(?:cocuk(?:lar|lara)?|izleyici(?:ler|lere)?|katilimci(?:lar|lara)?)\s+(?:icin(?:dir)?|yonelik(?:tir)?|uygun(?:dur)?|onerilir|katilabilir)|icin uygundur)/gu)) add(m, Number(m[1]));
  for (const m of text.matchAll(/\b(?:suitable|recommended|intended) for\s+(?:children\s+)?(?:aged?\s+)?(\d{1,3})\s*(?:\+|and (?:over|up)|or older)/gu)) add(m, Number(m[1]));
  for (const m of text.matchAll(/(?:^|[.!?;\n]\s*|\bage (?:limit|policy|restriction):?\s*|\b(?:suitable|recommended|open) (?:for|to)\s+)all ages\b/gu)) add(m, 0);
  for (const m of text.matchAll(/\b(?:her yas(?:tan izleyicilere)?(?: icin)? uygundur|yas siniri (?:yoktur|yok|bulunmamaktadir))\b/gu)) add(m, 0);
  for (const m of text.matchAll(/\b(?:adults? only|yetiskinlere ozel|18 yas ve uzeri)\b/gu)) add(m, 18);
  if (uncertain.length) return { status: 'unknown', evidence: [...rules.map(rule => rule.evidence), ...uncertain] };
  if (!rules.length) return { status: 'unknown', evidence: [] };
  const supported = rules.filter(rule => years >= rule.min && years <= rule.max);
  // Conflicting advertised rules retain unknown rather than picking a winner.
  const status = supported.length === rules.length ? 'supported'
    : supported.length ? 'unknown' : 'contradicted';
  return { status, evidence: rules.map(rule => rule.evidence) };
}
