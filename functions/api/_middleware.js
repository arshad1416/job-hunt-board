/* ═══════════════════════════════════════════════════════════════
   /api/* Middleware — CORS + Auth Gate
   ═══════════════════════════════════════════════════════════════

   Applies to ALL /api/* routes:
   - Always sets CORS headers
   - Handles OPTIONS preflight → 204
   - Skips auth for:  GET /api/health, GET /api/materials/*
   - Requires X-Auth-Token for mutations (generate, applied)
   ═══════════════════════════════════════════════════════════════ */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
  'Access-Control-Max-Age': '86400'
};

/** Paths that do NOT require authentication */
const PUBLIC_PATHS = [
  '/api/health'
];

/** Path prefixes that do NOT require authentication (GET only) */
const PUBLIC_PREFIXES = [
  '/api/materials/'
];

function isPublic(path, method) {
  // Health is always public (uptime checks)
  if (PUBLIC_PATHS.includes(path)) return true;
  // Materials GET is public (so browser can open in new tabs)
  if (method === 'GET' && PUBLIC_PATHS.some(p => path === p)) return true;
  if (method === 'GET') {
    for (const prefix of PUBLIC_PREFIXES) {
      if (path.startsWith(prefix)) return true;
    }
  }
  return false;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  // Check auth for non-public routes
  if (!isPublic(path, method)) {
    const authHeader = request.headers.get('X-Auth-Token');
    const expectedToken = env.DASHBOARD_AUTH_TOKEN;

    if (!expectedToken) {
      // No token configured on the server side — reject all mutations
      return new Response(
        JSON.stringify({ error: 'Server auth not configured (DASHBOARD_AUTH_TOKEN missing)' }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        }
      );
    }

    if (!authHeader || authHeader !== expectedToken) {
      return new Response(
        JSON.stringify({ error: 'unauthorized' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        }
      );
    }
  }

  // Add CORS headers to the downstream response
  const response = await next();
  const newResponse = new Response(response.body, response);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => {
    // Don't override Access-Control-Allow-Origin if already set
    if (!newResponse.headers.has(k)) {
      newResponse.headers.set(k, v);
    }
  });
  return newResponse;
}
