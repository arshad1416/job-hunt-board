/* ═══════════════════════════════════════════════════════════════
   /api/* Middleware — CORS + Auth Gate
   ═══════════════════════════════════════════════════════════════

   Applies to ALL /api/* routes:
   - CORS pinned to an allow-list of origins (never '*')
   - Handles OPTIONS preflight → 204
   - Public without auth:  GET /api/health  (uptime checks only)
   - Everything else needs either
       · a valid X-Auth-Token header, or
       · for GET /api/materials/:job_id/:filename, a valid signed
         ?token= (browser tabs cannot set request headers)
   ═══════════════════════════════════════════════════════════════ */

import { verifyMaterialsToken, timingSafeEqual } from '../_lib/signing.js';

/** Origins allowed to call the API cross-origin. Overridable via ALLOWED_ORIGINS. */
const DEFAULT_ALLOWED_ORIGINS = [
  'https://jobs.arshadkazi.ca',
  'https://job-hunt-board.pages.dev',
  'http://localhost:8788'
];

/** Only /api/health is reachable without credentials. */
const PUBLIC_PATHS = ['/api/health'];

/** GET /api/materials/<numeric job_id>/<filename> */
const MATERIALS_PATH = /^\/api\/materials\/(\d+)(?:\/versions\/([a-f0-9]{64})|)\/([A-Za-z0-9._-]+)$/i;

function allowedOrigins(env) {
  const raw = (env.ALLOWED_ORIGINS || '').trim();
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * CORS headers for this request. Access-Control-Allow-Origin is echoed
 * back only for allow-listed origins — an unknown origin gets no ACAO
 * at all, so the browser blocks the response. Same-origin requests from
 * the dashboard send no Origin and are unaffected.
 */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
    'Access-Control-Max-Age': '86400'
  };
  if (origin && allowedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/**
 * Decide whether the request may proceed.
 * @returns {Promise<Response|null>} a rejection Response, or null to allow
 */
async function authorize(request, env, url, method, cors) {
  const expectedToken = env.DASHBOARD_AUTH_TOKEN;

  if (!expectedToken) {
    // No token configured on the server side — fail closed.
    return json(
      { error: 'Server auth not configured (DASHBOARD_AUTH_TOKEN missing)' },
      503,
      cors
    );
  }

  const header = request.headers.get('X-Auth-Token');
  if (header && timingSafeEqual(header, expectedToken)) return null;

  // Signed, time-limited link — the only way a plain browser navigation
  // (window.open / new tab) can reach a material file.
  if (method === 'GET') {
    const match = MATERIALS_PATH.exec(url.pathname);
    if (match) {
      const ok = await verifyMaterialsToken(
        env,
        match[1],
        match[3],
        url.searchParams.get('token'),
        match[2] || null
      );
      if (ok) return null;
    }
  }

  return json({ error: 'unauthorized' }, 401, cors);
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const method = request.method;
  const cors = corsHeaders(request, env);

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...cors, Vary: 'Origin' }
    });
  }

  if (!PUBLIC_PATHS.includes(url.pathname)) {
    const denied = await authorize(request, env, url, method, cors);
    if (denied) return denied;
  }

  // Add CORS headers to the downstream response
  const response = await next();
  const newResponse = new Response(response.body, response);
  Object.entries(cors).forEach(([k, v]) => newResponse.headers.set(k, v));
  newResponse.headers.append('Vary', 'Origin');
  return newResponse;
}

/** Helper: JSON response carrying CORS headers */
function json(obj, status, cors) {
  // Private API errors are never cacheable or content-sniffable.
  const securityHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...securityHeaders,
      ...cors,
      Vary: 'Origin'
    }
  });
}
