import { parse } from './parser.ts';
const utterance = process.argv.slice(2).join(' ');
if (!utterance) throw new Error('Usage: node --experimental-strip-types cli.mjs "request"');
console.log(JSON.stringify(parse({ utterance, language: /[çğıöşü]|kisi|konser|sevgili/iu.test(utterance) ? 'tr' : 'en',
  referenceDate: '2026-10-01', timezone: 'Europe/Istanbul', previousState: null }), null, 2));
