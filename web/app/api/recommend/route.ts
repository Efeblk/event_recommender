import { recommend, validateInput } from '@/lib/recommend';
import { candidates, rateLimit, runtime } from '@/lib/store';
import { jevConfigFrom } from '@/lib/jev';
import { voyageConfigFrom } from '@/lib/voyage';
import { voyageVectorsFor } from '@/lib/voyage-index';
export async function POST(request: Request) {
  let input;
  try {
    if (Number(request.headers.get('content-length') || 0) > 24000)
      return Response.json({ error: 'Mesaj çok uzun.' }, { status: 413 });
    const raw = await request.text();
    if (raw.length > 24000)
      return Response.json({ error: 'Mesaj çok uzun.' }, { status: 413 });
    input = validateInput(JSON.parse(raw));
  } catch {
    return Response.json(
      {
        error:
          'Mesaj veya filtreler geçersiz. Tarihleri ve bütçeyi kontrol et.',
      },
      { status: 400 },
    );
  }
  try {
    const config = jevConfigFrom(runtime());
    const embeddingConfig = voyageConfigFrom(runtime());
    if (!(await rateLimit(request, Boolean(config || embeddingConfig))))
      return Response.json(
        {
          error:
            'Arama sınırına ulaşıldı. Bir süre sonra yeniden deneyebilirsin.',
        },
        { status: 429, headers: { 'Retry-After': '3600' } },
      );
    return Response.json(
      await recommend(input, {
        candidates,
        config,
        embeddingConfig,
        vectors: voyageVectorsFor,
      }),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { error: 'Arama tamamlanamadı. Lütfen yeniden dene.' },
      { status: 503 },
    );
  }
}
