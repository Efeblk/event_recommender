import {
  digest,
  runtime,
  acquireLease,
  releaseLease,
  eventLabelIndex,
  eventLabelIndexStatus,
} from '@/lib/store';
import { parseLabelIndexInput } from '@/lib/event-label-index';
import { jevConfigFrom } from '@/lib/jev';

// Collection-time event labeling (Phase 1R, R4). Each POST labels one bounded
// batch; the collector workflow repeats it within its run limits.
async function authorized(request: Request) {
  const token = runtime().SYNC_TOKEN;
  return (
    Boolean(token) &&
    (await digest(request.headers.get('authorization') ?? '')) ===
      (await digest(`Bearer ${token}`))
  );
}

export async function GET(request: Request) {
  if (!(await authorized(request)))
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return Response.json(await eventLabelIndexStatus());
  } catch {
    return Response.json({ error: 'Label status unavailable' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!(await authorized(request)))
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let config, input;
  try {
    config = jevConfigFrom(runtime());
    const body = await request.text();
    if (body.length > 1024) throw new Error('Label request too large');
    input = parseLabelIndexInput(JSON.parse(body));
  } catch {
    return Response.json({ error: 'Invalid label request or configuration' }, { status: 400 });
  }
  if (!config)
    return Response.json({ configured: false, error: 'Jev is not configured' }, { status: 503 });
  let lease;
  try {
    lease = await acquireLease('label_index_lock', 300_000);
    if (!lease)
      return Response.json({ error: 'Event labeling already running' }, { status: 409 });
    return Response.json(await eventLabelIndex(config, input, lease));
  } catch {
    return Response.json(
      { error: 'Event labeling stopped; no retry was attempted' },
      { status: 503 },
    );
  } finally {
    try {
      if (lease) await releaseLease(lease);
    } catch {
      // The bounded lease releases itself if cleanup is unavailable.
    }
  }
}
