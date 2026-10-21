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
    const upstream = await fetch(target, {
      headers: { 'Cf-Access-Jwt-Assertion': assertion }, redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const headers = new Headers(upstream.headers);
    headers.set('Cache-Control', 'no-store');
    headers.delete('Set-Cookie');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
