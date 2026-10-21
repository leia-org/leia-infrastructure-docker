import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

test('anonymous and unsupported requests never reach Auth', async () => {
  assert.equal((await worker.fetch(new Request('https://test-login.leia.ovh/'))).status, 403);
  assert.equal((await worker.fetch(new Request('https://test-login.leia.ovh/', { method: 'POST' }))).status, 405);
});
test('the chooser only forwards to the fixed Auth endpoint and never forwards cookies', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url.origin, 'https://pre.auth.leia.ovh');
      assert.equal(url.pathname, '/test-login');
      assert.equal(url.searchParams.get('target'), null);
      assert.equal(options.headers['Cf-Access-Jwt-Assertion'], 'access-proof');
      assert.equal(Object.keys(options.headers).length, 1);
      return new Response('chooser', { headers: { 'Set-Cookie': 'origin-cookie', 'Content-Type': 'text/html' } });
    };
    const response = await worker.fetch(new Request('https://test-login.leia.ovh/?target=https://evil.org&q=test', {
      headers: { 'Cf-Access-Jwt-Assertion': 'access-proof', Cookie: 'private-cookie' },
    }));
    assert.equal(response.status, 200); assert.equal(await response.text(), 'chooser');
    assert.equal(response.headers.get('Set-Cookie'), null); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  } finally { globalThis.fetch = originalFetch; }
});
