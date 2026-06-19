/**
 * POST /api/applied
 * Toggle job application status in Turso.
 */
export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const { job_id, applied } = await request.json();
    if (!job_id) {
      return new Response(JSON.stringify({ error: 'Missing job_id' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const id = parseInt(job_id) || 0;
    const status = applied ? 'applied' : 'found';
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const sql = applied
      ? `UPDATE applications SET status = 'applied', applied_at = '${timestamp}', updated_at = datetime('now') WHERE id = ${id}`
      : `UPDATE applications SET status = 'found', applied_at = NULL, updated_at = datetime('now') WHERE id = ${id}`;

    const url = env.TURSO_URL || 'https://morning-briefing-arshad1416.aws-us-east-1.turso.io';
    const token = env.TURSO_TOKEN;

    if (!token) {
      return new Response(JSON.stringify({ error: 'TURSO_TOKEN not configured' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const body = JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }] });
    const res = await fetch(`${url}/v2/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Turso error: ${err.substring(0, 200)}`);
    }

    return new Response(JSON.stringify({ success: true, job_id, status }), {
      status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });

  } catch (err) {
    console.error('Applied toggle error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
