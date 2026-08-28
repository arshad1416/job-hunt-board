/* ═══════════════════════════════════════════════════════════════
   /api/status — extended application status + append-only ledger
   Auth: X-Auth-Token required (enforced by _middleware.js)

   POST /api/status   { job_id, status, note? }
     Updates applications.status (extended vocabulary) and appends a
     row to the status_events ledger. Also maintains follow_up_due:
     set to applied_at + 7 days when entering the pipeline, cleared
     on rejected/ghosted.

   GET /api/status?job_id=123
     Returns the append-only ledger for that job (oldest first).
   ═══════════════════════════════════════════════════════════════ */

import { tursoExecute, tursoQuery } from '../_lib/turso.js';
import {
  normalizeStatus,
  statusLabel,
  isPostApplied,
  isFollowUpEligible,
  STATUSES,
  FOLLOW_UP_DAYS
} from '../_lib/status.js';

const STATUS_LIST = STATUSES.join(', ');

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const jobId = body.job_id;
  if (jobId === undefined || jobId === null || !/^\d+$/.test(String(jobId))) {
    return json({ error: 'Missing or invalid required field: job_id' }, 400);
  }

  const status = normalizeStatus(body.status);
  if (!status) {
    return json({ error: 'Invalid status. Allowed: ' + STATUS_LIST }, 400);
  }

  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;

  try {
    // Follow-up bookkeeping: an active pipeline status schedules a nudge
    // FOLLOW_UP_DAYS out; rejected/ghosted clear it. applied_at is stamped
    // on first entry and left alone afterwards.
    let sql;
    let args;
    let due = null;
    if (isPostApplied(status)) {
      const now = new Date().toISOString();
      due = isFollowUpEligible(status)
        ? new Date(new Date(now).getTime() + FOLLOW_UP_DAYS * 86400000)
            .toISOString().slice(0, 10)
        : null;
      sql = "UPDATE applications SET status=?, applied_at=coalesce(applied_at, ?), " +
            "follow_up_due=?, updated_at=datetime('now') WHERE id=?";
      args = [status, now, due, jobId];
    } else {
      // found / materials_ready / saved are pre-pipeline states. Clear the
      // active follow-up date when returning to them; preserve applied_at so
      // the first application timestamp remains auditable across status edits.
      sql = "UPDATE applications SET status=?, follow_up_due=NULL, updated_at=datetime('now') WHERE id=?";
      args = [status, jobId];
    }

    const result = await tursoExecute(env, sql, args);
    if (result.affectedRowCount === 0) {
      return json({ error: 'Job not found: ' + jobId }, 404);
    }

    // Append-only ledger entry. A ledger failure must not fail the
    // status change itself — the applications row is the source of
    // truth for the board; the ledger is history.
    let ledgerId = null;
    try {
      const ins = await tursoExecute(
        env,
        "INSERT INTO status_events (job_id, status, note) VALUES (?, ?, ?)",
        [jobId, status, note]
      );
      ledgerId = ins.lastInsertRowid;
    } catch (ledgerErr) {
      console.error('status_events append failed (non-fatal):', ledgerErr);
    }

    let appliedAt = null;
    let canonicalDue = due;
    try {
      const row = await tursoQuery(env, 'SELECT applied_at, follow_up_due FROM applications WHERE id=?', [jobId]);
      appliedAt = row[0]?.applied_at || null;
      canonicalDue = row[0]?.follow_up_due || null;
    } catch (readErr) {
      console.error('canonical status bookkeeping read failed (non-fatal):', readErr);
    }

    return json({
      success: true,
      job_id: jobId,
      status: status,
      label: statusLabel(status),
      applied_at: appliedAt,
      follow_up_due: canonicalDue,
      note: note,
      ledger_id: ledgerId
    });
  } catch (err) {
    console.error('status update error:', err);
    return json({ error: 'Database error: could not update status' }, 500);
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const jobId = url.searchParams.get('job_id');

  if (!jobId || !/^\d+$/.test(jobId)) {
    return json({ error: 'Missing or invalid job_id query parameter' }, 400);
  }

  try {
    const events = await tursoQuery(
      env,
      'SELECT id, job_id, status, note, created_at ' +
      'FROM status_events WHERE job_id=? ORDER BY id ASC',
      [parseInt(jobId, 10)]
    );
    return json({ job_id: parseInt(jobId, 10), events });
  } catch (err) {
    console.error('ledger read error:', err);
    return json({ error: 'Database error: could not read ledger' }, 500);
  }
}

/** Helper: JSON response */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
