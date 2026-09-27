const HOUR_MS = 60 * 60 * 1000;
const MAX_WINDOW_MS = 60 * HOUR_MS;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function collectionGate({ eventName, enabled, until, now = Date.now() }) {
  if (eventName === 'workflow_dispatch') return { run: true, reason: 'manual' };
  if (eventName !== 'schedule') return { run: false, reason: 'unsupported_event' };
  if (enabled !== 'true') return { run: false, reason: 'disabled' };
  if (!CANONICAL_UTC.test(until ?? '')) return { run: false, reason: 'invalid_deadline' };

  const deadline = Date.parse(until);
  if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== until)
    return { run: false, reason: 'invalid_deadline' };
  if (deadline <= now) return { run: false, reason: 'expired' };
  if (deadline - now > MAX_WINDOW_MS) return { run: false, reason: 'window_exceeds_60h' };
  return { run: true, reason: 'scheduled_window' };
}

if (process.argv[1] === import.meta.filename) {
  const result = collectionGate({
    eventName: process.env.EVENT_NAME ?? '',
    enabled: process.env.COLLECTION_ENABLED ?? '',
    until: process.env.COLLECTION_UNTIL ?? '',
  });
  console.error(`GCP staging collection gate: ${result.reason}`);
  process.stdout.write(`run=${result.run}\n`);
}
