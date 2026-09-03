import { tursoQuery } from '../_lib/turso.js';
import { getMaterialPdfState, getCurrentMaterial } from '../_lib/material-store.js';

// GET /api/generate-status?job_id=N — poll target for async generation.
// Reports the latest material_version lifecycle state, the current pointer,
// render availability, and (when staged) the quality block from
// job_details.json so the modal can show the same summary as before.
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary: Origin' } });

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const jobId = q.get('job_id');
  if (!jobId || !/^\d+$/.test(jobId) || Number(jobId) > 2147483647) return json({ error: 'job_id must be numeric' }, 400);
  try {
    const rows = await tursoQuery(env, 'SELECT id, version, state, error_code, attempt_count, lease_expires_at, completed_at FROM material_versions WHERE job_id=? ORDER BY id DESC LIMIT 1', [jobId]);
    const row = rows[0] || null;
    const current = await getCurrentMaterial(env, jobId);
    let quality = null;
    let pdfState = { state: 'pending', ready: false };
    if (current?.artifact_prefix && env.JOB_MATERIALS_BUCKET) {
      pdfState = await getMaterialPdfState(env, jobId, current, env.JOB_MATERIALS_BUCKET);
      try {
        const detailsObj = await env.JOB_MATERIALS_BUCKET.get(current.artifact_prefix + '/job_details.json');
        if (detailsObj) {
          const details = JSON.parse(await detailsObj.text());
          quality = details.quality ? {
            ats_score: details.quality.ats?.score ?? null,
            ats_pass: details.quality.atsPass ?? null,
            facts_ok: details.quality.facts?.ok ?? null,
            keyword_coverage: details.quality.keywordCoverage ?? null,
            reviewer_used: details.reviewer?.used === true || details.reviewer?.reason === 'quality_rank_not_improved'
          } : null;
        }
      } catch { quality = null; }
    }
    // 'succeeded' requires the published pointer: a succeeded row without
    // one is still publishing (material-links would 404 otherwise).
    let generationState;
    if (current) generationState = 'succeeded';
    else if (!row) generationState = 'none';
    else if (row.state === 'succeeded') generationState = 'publishing';
    else if (row.state === 'failed') generationState = (row.error_code === 'superseded' || row.attempt_count >= 3) ? 'failed' : 'retrying';
    else generationState = row.state;
    return json({
      job_id: jobId,
      generation_state: generationState,
      attempt_count: row?.attempt_count ?? 0,
      error_code: row?.error_code ?? null,
      version: current?.version ?? row?.version ?? null,
      pdf_state: pdfState.state,
      pdf_ready: pdfState.ready === true,
      quality
    });
  } catch (error) {
    console.error('generate status read failed:', error);
    return json({ error: 'Database error: could not read generation status' }, 500);
  }
}
