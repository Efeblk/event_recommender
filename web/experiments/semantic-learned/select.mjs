import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const work = resolve(import.meta.dirname, '../../work/semantic-learned-20261001');
const bytes = readFileSync(resolve(work, 'fresh-cases.json'));
const parsed = JSON.parse(bytes);
const cases = Array.isArray(parsed) ? parsed : parsed.cases;
// Do not inspect or print utterances, gold trees or prior-state contents at selection time.
const metadata = cases.map((c) => ({ id: c.id, language: c.language, slice: c.slice, chainId: c.chainId,
  turn: c.turn, seeded: Boolean(c.previousState) }));
const selected = [], final = [];
for (const language of ['tr', 'en']) {
  const clear = metadata.filter((c) => c.language === language && c.slice === 'clear').sort((a, b) => a.id.localeCompare(b.id));
  const chosen = clear.filter((c) => c.chainId);
  for (const c of clear.filter((c) => c.seeded && !c.chainId).slice(0, 2)) if (!chosen.some((v) => v.id === c.id)) chosen.push(c);
  for (const c of clear) if (chosen.length < 8 && !chosen.some((v) => v.id === c.id)) chosen.push(c);
  assert.equal(chosen.length, 8);
  selected.push(...chosen);
  const amb = metadata.filter((c) => c.language === language && c.slice === 'ambiguous').sort((a, b) => a.id.localeCompare(b.id)).slice(0, 2);
  const uns = metadata.filter((c) => c.language === language && c.slice === 'unsupported').sort((a, b) => a.id.localeCompare(b.id)).slice(0, 2);
  assert.equal(amb.length, 2); assert.equal(uns.length, 2);
  selected.push(...amb, ...uns);
  final.push(chosen.filter((c) => !c.chainId).at(-1).id, uns.at(-1).id);
}
const selectedIds = new Set(selected.map((c) => c.id));
const ordered = metadata.filter((c) => selectedIds.has(c.id)).map((c) => ({ ...c,
  cohort: final.includes(c.id) ? 'final-confirmation' : 'fresh-main' }));
assert.equal(ordered.length, 24);
assert.equal(ordered.filter((c) => c.chainId).length, metadata.filter((c) => c.chainId).length);
const receipt = { at: new Date().toISOString(), corpusSha256: createHash('sha256').update(bytes).digest('hex'),
  method: 'Frozen metadata-only selection per evaluation-policy.json; no utterance/gold inspected by this selector',
  cases: ordered, unused: metadata.filter((c) => !selectedIds.has(c.id)).map((c) => c.id) };
writeFileSync(resolve(work, 'selection.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ selected: ordered.length, chains: ordered.filter((c) => c.chainId).length,
  finalReserved: final.length, corpusSha256: receipt.corpusSha256 }));
