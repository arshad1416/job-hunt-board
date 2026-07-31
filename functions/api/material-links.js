/* ═══════════════════════════════════════════════════════════════
   POST /api/material-links
   Auth: X-Auth-Token required (enforced by _middleware.js)

   Body: { "job_id": 123 }
   Returns short-lived signed URLs for that job's materials so the
   dashboard can open them in new tabs without the files being
   world-readable.
   ═══════════════════════════════════════════════════════════════ */

import { signedMaterialUrls, DEFAULT_TTL_SECONDS } from '../_lib/signing.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const jobId = body.job_id;
  if (jobId === undefined || jobId === null) {
    return json({ error: 'Missing required field: job_id' }, 400);
  }
  if (!/^\d+$/.test(String(jobId))) {
    return json({ error: 'Invalid job_id' }, 400);
  }

  let materials;
  try {
    materials = await signedMaterialUrls(env, String(jobId));
  } catch (err) {
    console.error('Signing error:', err);
    return json({ error: 'Server signing key not configured' }, 503);
  }

  return json({
    success: true,
    job_id: jobId,
    expires_in: DEFAULT_TTL_SECONDS,
    materials
  });
}

/** Helper: JSON response */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
