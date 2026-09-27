import { isIP } from 'node:net';

const SHARED_CLIENT = 'shared';

function normalizeIpv4(value: string): string | null {
  if (isIP(value) !== 4) return null;
  const octets = value.split('.');
  if (
    octets.length !== 4 ||
    octets.some((octet) => !/^(0|[1-9]\d{0,2})$/.test(octet))
  ) {
    return null;
  }
  return octets.map((octet) => String(Number(octet))).join('.');
}

function normalizeIp(value: string): string | null {
  const candidate = value.trim();
  const ipv4 = normalizeIpv4(candidate);
  if (ipv4) return ipv4;
  if (isIP(candidate) !== 6 || candidate.includes('%')) return null;

  // URL uses the WHATWG canonical IPv6 serialization, including compression
  // and lowercase hexadecimal. isIP above prevents URL syntax from being
  // interpreted as anything except an IPv6 address.
  const normalized = new URL(`http://[${candidate}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;

  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
}

/**
 * Resolve a rate-limit identity for a service reached directly through its
 * Cloud Run run.app URL.
 *
 * Google documents X-Forwarded-For as client followed by proxies. In direct
 * mode, only the rightmost platform-appended value is trusted; caller-supplied
 * values to its left are ignored. Load balancers append a different shape and
 * therefore require a separate, qualified mode before they can be trusted.
 * https://docs.cloud.google.com/functions/docs/reference/headers
 * https://docs.cloud.google.com/load-balancing/docs/https#x-forwarded-for_header
 */
export function clientIp(
  request: Request,
  env: Record<string, string | undefined>,
): string {
  if (env.BIPLAN_CLIENT_IP_MODE !== 'cloud-run-direct') return SHARED_CLIENT;

  const forwarded = request.headers.get('x-forwarded-for');
  if (!forwarded) return SHARED_CLIENT;
  const values = forwarded.split(',');
  if (values.length > 32) return SHARED_CLIENT;
  return normalizeIp(values.at(-1) ?? '') ?? SHARED_CLIENT;
}
