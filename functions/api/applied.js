/* ═══════════════════════════════════════════════════════════════
   POST /api/applied
   Auth: X-Auth-Token required (enforced by _middleware.js)

   Body: { "job_id": 123, "applied": true }
   Updates applications.status to 'applied' or 'found' and sets
   applied_at accordingly. Uses parameterized statements.
   ═══════════════════════════════════════════════════════════════ */

import { tursoExecute } from '../_lib/turso.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  // ── Parse body ──
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const jobId = body.job_id;
  const applied = body.applied;

  if (jobId === undefined || jobId === null) {
    return json({ error: 'Missing required field: job_id' }, 400);
  }

  if (typeof applied !== 'boolean') {
    return json({ error: 'Missing or invalid field: applied (must be boolean)' }, 400);
  }

  // Determine new status
  const newStatus = applied ? 'applied' : 'found';

  try {
    const result = await tursoExecute(
      env,
      'UPDATE applications SET status=?, applied_at=?, updated_at=datetime(\'now\') WHERE id=?',
      [
        newStatus,
        applied ? new Date().toISOString() : null,
        jobId
      ]
    );

    if (result.affectedRowCount === 0) {
      return json({ error: 'Job not found: ' + jobId }, 404);
    }

    return json({
      success: true,
      job_id: jobId,
      status: newStatus,
      applied: applied
    });
  } catch (err) {
    console.error('Turso update error:', err);
    return json({ error: 'Database error: could not update status' }, 500);
  }
}

/** Helper: JSON response */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
