// Access protects test-login.leia.ovh. Auth independently validates every assertion.
export default {
  async fetch(request) {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!assertion) return new Response('Cloudflare Access login required', { status: 403 });
    const input = new URL(request.url);
    if (input.pathname !== '/') return new Response('Not found', { status: 404 });
    const target = new URL('https://pre.auth.leia.ovh/test-login');
    for (const key of ['returnTo', 'q']) {
      if (input.searchParams.has(key)) target.searchParams.set(key, input.searchParams.get(key));
    }
    let upstream;
    try {
      upstream = await fetch(target, {
        headers: { 'Cf-Access-Jwt-Assertion': assertion }, redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return new Response('Auth pre is temporarily unavailable. Please try again.', { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
    // Never forward an Access assertion to a redirect destination.
    if (upstream.status >= 300 && upstream.status < 400) {
      return new Response('Unexpected Auth pre redirect. Please try again later.', { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
    const headers = new Headers(upstream.headers);
    headers.set('Cache-Control', 'no-store');
    headers.delete('Set-Cookie');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
