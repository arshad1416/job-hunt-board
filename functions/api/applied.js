/* ═══════════════════════════════════════════════════════════════
   POST /api/applied
   Auth: X-Auth-Token required (enforced by _middleware.js)

   Body: { "job_id": 123, "applied": true }
   Updates applications.status to 'applied' or 'found' and maintains
   applied_at/follow_up_due without downgrading active pipeline statuses. Uses parameterized statements.
   ═══════════════════════════════════════════════════════════════ */

import { tursoExecute, tursoQuery } from '../_lib/turso.js';
import { statusLabel, FOLLOW_UP_DAYS } from '../_lib/status.js';

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

  if (jobId === undefined || jobId === null || !/^\d+$/.test(String(jobId))) {
    return json({ error: 'Missing or invalid required field: job_id' }, 400);
  }

  if (typeof applied !== 'boolean') {
    return json({ error: 'Missing or invalid field: applied (must be boolean)' }, 400);
  }

  // Determine new status
  const newStatus = applied ? 'applied' : 'found';

  try {
    if (!applied) {
      const current = await tursoQuery(env, 'SELECT status FROM applications WHERE id=?', [jobId]);
      const status = current[0]?.status;
      if (!status) return json({ error: 'Job not found: ' + jobId }, 404);
      if (!['found', 'materials_ready', 'saved', 'not_applied', 'new', 'applied'].includes(status)) {
        return json({ error: 'Use /api/status for active pipeline statuses' }, 409);
      }
    }
    const appliedAt = applied ? new Date().toISOString() : null;
    const followUpDue = applied
      ? new Date(Date.now() + FOLLOW_UP_DAYS * 86400000).toISOString().slice(0, 10)
      : null;
    const result = await tursoExecute(
      env,
      applied
        ? 'UPDATE applications SET status=?, applied_at=coalesce(applied_at, ?), follow_up_due=?, updated_at=datetime(\'now\') WHERE id=?'
        : 'UPDATE applications SET status=?, follow_up_due=NULL, updated_at=datetime(\'now\') WHERE id=? AND status IN (\'found\',\'materials_ready\',\'saved\',\'not_applied\',\'new\',\'applied\')',
      applied
        ? [newStatus, appliedAt, followUpDue, jobId]
        : [newStatus, jobId]
    );

    if (result.affectedRowCount === 0) {
      return json({ error: 'Job not found: ' + jobId }, 404);
    }

    // Append an entry to the status_events ledger (migration 002) so the
    // applied/unapplied toggle is recorded like any other status change.
    // Non-fatal: the ledger table may not exist yet on old databases.
    try {
      await tursoExecute(
        env,
        "INSERT INTO status_events (job_id, status, note) VALUES (?, ?, ?)",
        [jobId, newStatus, applied ? 'marked applied (legacy toggle)' : 'reverted to found (legacy toggle)']
      );
    } catch (ledgerErr) {
      console.error('status_events append failed (non-fatal):', ledgerErr);
    }

    return json({
      success: true,
      job_id: jobId,
      status: newStatus,
      label: statusLabel(newStatus),
      applied: applied,
      applied_at: appliedAt,
      follow_up_due: followUpDue,
      follow_up_days: applied ? FOLLOW_UP_DAYS : null
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
