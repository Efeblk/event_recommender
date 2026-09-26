import { jevConfigFrom } from '@/lib/jev';
import { voyageConfigFrom } from '@/lib/voyage';
import { catalogStatus, runtime } from '@/lib/store';
export async function GET() {
  try {
    const catalog = await catalogStatus();
    return Response.json({
      status: 'ok',
      aiEnabled: Boolean(
        jevConfigFrom(runtime()) || voyageConfigFrom(runtime()),
      ),
      deployment: {
        environment: runtime().DEPLOYMENT_ENV || 'local',
        revision: runtime().DEPLOYMENT_SHA || null,
      },
      catalog,
    });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503 });
  }
}
