import assert from 'node:assert/strict';
import test from 'node:test';

import { executeWebFetch, extractReadableText } from './web-fetch.mjs';

const PUBLIC_IP = '93.184.216.34';

test('web.fetch SSRF guard refuses private, loopback, link-local, CGNAT, and non-http(s) URLs', async () => {
  const blocked = [
    'http://127.0.0.1/admin',
    'http://10.1.2.3/admin',
    'http://100.64.0.1/admin',
    'http://169.254.10.20/admin',
    'file:///etc/passwd',
  ];

  for (const url of blocked) {
    const result = await executeWebFetch(
      { url },
      {
        fetchImpl: async () => {
          throw new Error('fetch must not run for blocked URLs');
        },
      },
    );
    assert.equal(result.ok, false, url);
    assert.match(result.reason, /blocked_url|unsupported_scheme/, url);
  }
});

test('web.fetch re-checks redirect hops and refuses a redirect into a private range', async () => {
  const fetchedUrls = [];
  const result = await executeWebFetch(
    { url: 'https://public.example/start' },
    {
      resolveHost: async (host) => (host === 'public.example' ? [PUBLIC_IP] : ['127.0.0.1']),
      fetchImpl: async (url) => {
        fetchedUrls.push(url);
        return {
          ok: false,
          status: 302,
          headers: new Map([['location', 'http://127.0.0.1/private']]),
        };
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blocked_url');
  assert.deepEqual(fetchedUrls, ['https://public.example/start']);
});

test('web.fetch strips scripts/styles/tags and bounds extracted text', async () => {
  const html = `
    <html>
      <head>
        <title>Weather &amp; Alerts</title>
        <style>.secret { color: red; }</style>
        <script>window.token = "SECRET";</script>
      </head>
      <body>
        <h1>Chiang Mai</h1>
        <p>Currently <strong>31C</strong> and partly cloudy.</p>
        <p>Afternoon showers possible.</p>
      </body>
    </html>`;

  const result = await executeWebFetch(
    { url: 'https://weather.example/chiang-mai', maxChars: 45 },
    {
      resolveHost: async () => [PUBLIC_IP],
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(typeof result.output, 'string');
  assert.ok(result.output.startsWith('fetched https://weather.example/chiang-mai:\nWeather & Alerts\n'));
  assert.ok(!result.output.includes('<strong>'));
  assert.ok(!result.output.includes('SECRET'));
  assert.ok(!result.output.includes('color: red'));

  const extracted = result.output.split('\n').at(-1);
  assert.ok(extracted.length <= 45);
  assert.equal(extractReadableText('<p>A</p> <script>B</script> <style>C</style> <b>D</b>', 10), 'A D');
});
