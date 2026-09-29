import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAttendanceTiming } from '../lib/event-timing.ts';

await test('attendance timing parser accepts exact supported shapes', () => {
  assert.deepEqual(parseAttendanceTiming(undefined), undefined);
  assert.deepEqual(parseAttendanceTiming({
    kind: 'timed_session', evidence: 'provider_sessions_and_source_text',
  }), { kind: 'timed_session', evidence: 'provider_sessions_and_source_text' });
  assert.deepEqual(parseAttendanceTiming({
    kind: 'admission_window', evidence: 'provider_flexible_window',
    validFrom: '2026-09-01T07:00:00.000Z', validThrough: '2026-09-30T14:00:00.000Z',
  }), {
    kind: 'admission_window', evidence: 'provider_flexible_window',
    validFrom: '2026-09-01T07:00:00.000Z', validThrough: '2026-09-30T14:00:00.000Z',
  });
});

await test('attendance timing parser rejects mismatched evidence, malformed bounds and extra fields', () => {
  for (const value of [
    null,
    { kind: 'timed_session', evidence: 'insufficient_source_evidence' },
    { kind: 'unknown', evidence: 'insufficient_source_evidence', reason: 'conflict' },
    { kind: 'admission_window', evidence: 'provider_flexible_window', validFrom: '2026-09-30T14:00:00.000Z', validThrough: '2026-09-01T07:00:00.000Z' },
    { kind: 'admission_window', evidence: 'provider_flexible_window', validFrom: '2026-09-01T07:00:00Z', validThrough: '2026-09-30T14:00:00.000Z' },
  ]) assert.throws(() => parseAttendanceTiming(value), /Invalid attendance timing/);
});
