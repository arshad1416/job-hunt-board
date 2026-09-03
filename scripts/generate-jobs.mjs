#!/usr/bin/env node
// generate-jobs.mjs — Pi-side generation worker (async generation).
//
// POST /api/generate on the edge only stages a pending material_versions
// row and answers 202; the LLM pipeline needs up to ~3 minutes and would be
// 524-cut at the ~100s edge limit. This worker claims pending rows and runs
// the full production pipeline (functions/api/generate.js runGenerate with
// GENERATION_WORKER=1) against the same Turso/R2/9Router the Pages function
// uses. Dry-run by default; --execute processes up to --limit jobs.
import { tursoQuery } from './lib/turso.mjs';
import { createR2S3 } from './lib/r2-s3.mjs';
import { acquireFetchLock } from './lib/lock.mjs';
import { runGenerate } from '../functions/api/generate.js';

const MAX_ATTEMPTS = 3;

export async function pollClaimableJobs({ env, limit = 3, query = tursoQuery, execute: write = null } = {}) {
  // Latest claimable row per job. A failed row is claimable once its lease is
  // gone and it is past the backoff window (markMaterialFailed does not set
  // retry_at, so the render-jobs retry_at predicate cannot be reused here).
  const rows = await query(env,
    "SELECT mv.job_id, mv.id AS latest FROM material_versions mv " +
    "WHERE mv.id=(SELECT MAX(m2.id) FROM material_versions m2 WHERE m2.job_id=mv.job_id) " +
    "AND (mv.state='pending' OR (mv.state='claimed' AND datetime(mv.lease_expires_at)<=datetime('now')) OR (mv.state='failed' AND mv.lease_token IS NULL AND mv.attempt_count<? AND (mv.completed_at IS NULL OR mv.completed_at<=datetime('now','-60 seconds')))) " +
    "AND mv.attempt_count<? " +
    "AND NOT EXISTS (SELECT 1 FROM material_current mc WHERE mc.job_id=mv.job_id) " +
    "ORDER BY mv.id LIMIT ?", [MAX_ATTEMPTS, MAX_ATTEMPTS, Math.min(10, Math.max(1, limit))]);
  return rows.map(r => ({ jobId: r.job_id, latest: r.latest }));
}

/** Mark older non-terminal rows for a job superseded: only the latest
 * version row may run (protects the one-active-row unique index when the
 * profile/JD drifted between enqueue and execution). */
export async function supersedeOlderRows(env, jobId, latest, write) {
  await write(env, "UPDATE material_versions SET state='failed', error_code='superseded', lease_token=NULL, lease_expires_at=NULL, completed_at=datetime('now') WHERE job_id=? AND id<? AND state IN ('pending','claimed') AND (lease_expires_at IS NULL OR datetime(lease_expires_at)<=datetime('now'))", [jobId, latest]);
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 3;
  const env = process.env;
  if (!env.TURSO_URL || !env.TURSO_TOKEN) throw new Error('TURSO_URL and TURSO_TOKEN are required');
  if (execute && !env.NINEROUTER_API_KEY) throw new Error('NINEROUTER_API_KEY is required');
  if (execute && !env.DASHBOARD_AUTH_TOKEN) throw new Error('DASHBOARD_AUTH_TOKEN is required (material link signing)');

  const lock = acquireFetchLock('generate-jobs', { startedAtMs: Date.now() });
  if (!lock.ok) { console.log(JSON.stringify({ error: 'lock_unavailable' })); process.exitCode = 0; return; }
  try {
    const jobs = await pollClaimableJobs({ env, limit });
    if (!execute) { console.log(JSON.stringify({ dryRun: true, count: jobs.length, job_ids: jobs.map(j => j.jobId) })); return; }
    const results = [];
    for (const { jobId, latest } of jobs) {
      // One unexpected job must not abort the batch; the row's lease expiry
      // is the safety net for a crash mid-run.
      try {
        await supersedeOlderRows(env, jobId, latest, (await import('./lib/turso.mjs')).tursoExecute);
        const res = await runGenerate({
          request: new Request('https://worker/api/generate', { method: 'POST', body: JSON.stringify({ job_id: String(jobId) }) }),
          env: { ...env, GENERATION_WORKER: '1', GENERATION_LEASE_SECONDS: env.GENERATION_LEASE_SECONDS || '600', JOB_MATERIALS_BUCKET: env.JOB_MATERIALS_BUCKET || createR2S3(env) }
        });
        let body = null;
        try { body = await res.json(); } catch {}
        results.push({ job_id: jobId, status: res.status, error: body?.error || null, cached: body?.cached === true });
      } catch (err) {
        results.push({ job_id: jobId, status: 0, error: String(err.message || err).slice(0, 120) });
      }
    }
    // Infrastructure failures (5xx/uncaught) exit nonzero so cron logs stand
    // out; terminal job-quality failures (422/409) do not page.
    const infra = results.filter(r => r.status >= 500 || r.status === 0);
    console.log(JSON.stringify({ dryRun: false, count: jobs.length, results }));
    if (infra.length) process.exitCode = 1;
  } finally {
    lock.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
