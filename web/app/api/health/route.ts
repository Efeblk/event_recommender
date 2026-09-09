import { configFrom } from '@/lib/ai';
import { database, runtime } from '@/lib/store';
export async function GET() {
  try {
    await (await database()).prepare('SELECT 1').first();
    return Response.json({
      status: 'ok',
      aiEnabled: Boolean(configFrom(runtime())),
    });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503 });
  }
}
