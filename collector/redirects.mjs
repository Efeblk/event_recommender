export const DETAIL_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Resolve one provider detail redirect without changing the discovered URL's
 * identity. Callers still parse/checkpoint against the initial URL; this only
 * chooses the next representation to fetch.
 */
export function nextDetailRedirect({
  initialUrl,
  currentUrl,
  location,
  source,
  detailUrl,
  visited,
  redirects,
  maxRedirects = 3,
}) {
  if (redirects >= maxRedirects) throw new Error('redirect_limit');
  if (typeof location !== 'string' || !location.trim())
    throw new Error('redirect_location_missing');
  let initial, target;
  try {
    initial = new URL(initialUrl);
    target = new URL(location, currentUrl);
  } catch {
    throw new Error('redirect_location_invalid');
  }
  if (target.protocol !== 'https:' || target.origin !== initial.origin)
    throw new Error('redirect_cross_origin');
  const canonical = detailUrl(target.href, source);
  if (!canonical) throw new Error('redirect_not_detail');
  // A Biletix SEO title may change, but its event code is the stable identity.
  // Never permit a redirect to silently replace it with another production.
  if (source === 'biletix' && canonical !== detailUrl(initial.href, source))
    throw new Error('redirect_identity_changed');
  const fetchUrl = target.origin + target.pathname;
  if (visited.has(fetchUrl)) throw new Error('redirect_loop');
  return fetchUrl;
}

export async function followDetailRedirects({
  initialUrl,
  source,
  request,
  detailUrl,
  maxRedirects = 3,
}) {
  let currentUrl = new URL(initialUrl).href, redirects = 0;
  const visited = new Set([currentUrl]);
  for (;;) {
    const response = await request(currentUrl);
    if (!DETAIL_REDIRECT_STATUSES.has(response.status))
      return { response, finalUrl: currentUrl, redirects };
    let target;
    let policyError;
    try {
      target = nextDetailRedirect({
        initialUrl, currentUrl, location: response.headers.get('location'),
        source, detailUrl, visited, redirects, maxRedirects,
      });
    } catch (error) {
      policyError = error;
    } finally {
      // Redirect bodies are never parsed. Cleanup is best-effort and must not
      // replace the more useful redirect policy failure.
      try { await response.body?.cancel(); } catch { /* preserve policy result */ }
    }
    if (policyError)
      throw new Error(`http_${response.status}:${policyError.message}`);
    visited.add(target); currentUrl = target; redirects += 1;
  }
}
