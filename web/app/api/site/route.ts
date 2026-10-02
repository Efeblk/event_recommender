import { runtime } from '@/lib/store';

export async function GET() {
  let donationUrl: string | null = null;
  const configuredRuntime = runtime();
  const configured = configuredRuntime.DONATION_URL;
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:' && !url.username && !url.password)
        donationUrl = url.href;
    } catch {
      // An unset or malformed destination leaves support in its coming-soon state.
    }
  }
  return Response.json(
    {
      donationUrl,
      intentVersion: configuredRuntime.INPUT_INTERPRETER === 'span-v2' ? 2 : 1,
    },
    {
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
