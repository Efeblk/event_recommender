import { digest, runtime, legacySync } from '@/lib/store';
export async function POST(request: Request) {
  const token = runtime().SYNC_TOKEN;
  if (
    !token ||
    (await digest(request.headers.get('authorization') ?? '')) !==
      (await digest(`Bearer ${token}`))
  )
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return legacySync(request);
}
