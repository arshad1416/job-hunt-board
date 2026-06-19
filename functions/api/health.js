/* ═══════════════════════════════════════════════════════════════
   GET /api/health — Liveness + config check
   Public (no auth required) — safe for uptime monitors.
   ═══════════════════════════════════════════════════════════════ */

export async function onRequestGet(context) {
  const { env } = context;

  const config = {
    turso_url: !!env.TURSO_URL,
    turso_token: !!env.TURSO_TOKEN,
    glm_key: !!env.OPENCODE_GO_API_KEY,
    r2_bucket: !!env.JOB_MATERIALS_BUCKET,
    auth_token: !!env.DASHBOARD_AUTH_TOKEN
  };

  const allConfigured = Object.values(config).every(Boolean);

  return new Response(
    JSON.stringify({
      ok: true,
      configured: allConfigured,
      config,
      timestamp: new Date().toISOString()
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}
