/**
 * S Reader — RSS CORS Proxy
 *
 * Deploy to Cloudflare Workers (free tier: 100,000 requests/day).
 *
 * SETUP
 * ─────
 * 1. Go to https://dash.cloudflare.com  →  create a free account
 * 2. Workers & Pages  →  Create  →  Start with Hello World  →  Deploy
 * 3. Click "Edit code", replace everything with this file, Deploy
 * 4. Copy your worker URL, e.g. https://s-reader-proxy.YOURNAME.workers.dev
 * 5. Paste that URL into PROXY_WORKER_URL at the top of app.js
 *
 * Usage:  https://your-worker.workers.dev/?url=https%3A%2F%2Fexample.com%2Ffeed
 */

const ALLOWED_ORIGINS = [
  'https://vwsung18t.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return new Response('Missing ?url= parameter', { status: 400, headers: cors });
    }

    // Only allow http(s) — prevents the worker being used to probe internal addresses
    let parsed;
    try {
      parsed = new URL(target);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
    } catch {
      return new Response('Invalid url parameter', { status: 400, headers: cors });
    }

    try {
      const upstream = await fetch(parsed.toString(), {
        headers: {
          // Some feeds reject requests without a normal UA
          'User-Agent': 'Mozilla/5.0 (compatible; SReader/1.0; +https://github.com/)',
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
        // Cache at the edge for 5 minutes to cut upstream load
        cf: { cacheTtl: 300, cacheEverything: true },
      });

      if (!upstream.ok) {
        return new Response(`Upstream returned ${upstream.status}`, {
          status: upstream.status,
          headers: cors,
        });
      }

      const body = await upstream.text();
      return new Response(body, {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      });
    } catch (e) {
      return new Response(`Fetch failed: ${e.message}`, { status: 502, headers: cors });
    }
  },
};
