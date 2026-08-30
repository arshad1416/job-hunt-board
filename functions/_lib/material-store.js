import { tursoQuery, tursoExecute } from './turso.js';

const LEASE_SECONDS = 300;
const MAX_ERROR_LENGTH = 240;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_SECONDS = 30;

function secureToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error('Secure random UUID is unavailable');
}

function boundedError(value) {
  return String(value || 'material operation failed').replace(/[\r\n]+/g, ' ').slice(0, MAX_ERROR_LENGTH);
}

async function ensureMaterialVersion(env, { jobId, version, reusedFromJobId = null, profileRevision = null, templateRevision = null, rendererRevision = null }) {
  await tursoExecute(env,
    'INSERT INTO material_versions (job_id, version, reused_from_job_id, profile_revision, template_revision, renderer_revision) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, version) DO NOTHING',
    [jobId, version, reusedFromJobId, profileRevision, templateRevision, rendererRevision]
  );
  return getMaterialVersion(env, jobId, version);
}

async function getMaterialVersion(env, jobId, version) {
  const rows = await tursoQuery(env,
    'SELECT * FROM material_versions WHERE job_id=? AND version=? LIMIT 1',
    [jobId, version]);
  return rows[0] || null;
}

async function resetFailedMaterial(env, { jobId, version }) {
  const result = await tursoExecute(env, "UPDATE material_versions SET state='pending', updated_at=datetime('now') WHERE job_id=? AND version=? AND state='failed' AND lease_token IS NULL AND attempt_count < ? AND (completed_at IS NULL OR completed_at <= datetime('now', '-' || ? || ' seconds')) AND NOT EXISTS (SELECT 1 FROM material_current WHERE job_id=?)", [jobId, version, MAX_ATTEMPTS, RETRY_BACKOFF_SECONDS, jobId]);
  return Number(result.affectedRowCount) === 1;
}

async function claimMaterial(env, { jobId, version, leaseSeconds = LEASE_SECONDS, leaseToken = secureToken() }) {
  await resetFailedMaterial(env, { jobId, version });
  const result = await tursoExecute(env,
    "UPDATE material_versions SET state='claimed', lease_token=?, lease_expires_at=datetime('now', '+' || ? || ' seconds'), attempt_count=attempt_count+1, updated_at=datetime('now'), error_code=NULL, error_message=NULL WHERE job_id=? AND version=? AND (state='pending' OR (state='claimed' AND lease_expires_at <= datetime('now'))) AND attempt_count < ?",
    [leaseToken, leaseSeconds, jobId, version, MAX_ATTEMPTS]);
  return { claimed: Number(result.affectedRowCount) === 1, leaseToken };
}

async function markMaterialSucceeded(env, { jobId, version, leaseToken, artifactPrefix, sourceExists = true, hardGatesPass = true }) {
  if (!sourceExists || !hardGatesPass || !leaseToken || !artifactPrefix) return false;
  const result = await tursoExecute(env,
    "UPDATE material_versions SET state='succeeded', source_exists=1, hard_gates_pass=1, artifact_prefix=?, lease_token=NULL, lease_expires_at=NULL, completed_at=datetime('now'), updated_at=datetime('now') WHERE job_id=? AND version=? AND state='claimed' AND lease_token=? AND lease_expires_at > datetime('now')",
    [artifactPrefix || null, jobId, version, leaseToken]);
  return Number(result.affectedRowCount) === 1;
}

async function markMaterialFailed(env, { jobId, version, leaseToken, errorCode = 'material_failed', errorMessage }) {
  if (!leaseToken) return false;
  const result = await tursoExecute(env,
    "UPDATE material_versions SET state='failed', source_exists=0, hard_gates_pass=0, error_code=?, error_message=?, lease_token=NULL, lease_expires_at=NULL, updated_at=datetime('now') WHERE job_id=? AND version=? AND state='claimed' AND lease_token=?",
    [String(errorCode).slice(0, 80), boundedError(errorMessage || errorCode), jobId, version, leaseToken]);
  return Number(result.affectedRowCount) === 1;
}

async function getCurrentSuccessfulMaterial(env, jobId) {
  const rows = await tursoQuery(env,
    "SELECT * FROM material_versions WHERE job_id=? AND state='succeeded' AND source_exists=1 AND hard_gates_pass=1 ORDER BY completed_at DESC, id DESC LIMIT 1",
    [jobId]);
  return rows[0] || null;
}

async function projectMaterialsReady(env, jobId, version) {
  const result = await tursoExecute(env,
    "UPDATE applications SET status='materials_ready', updated_at=datetime('now') WHERE id=? AND status IN ('found','saved','not_applied','new') AND EXISTS (SELECT 1 FROM material_versions WHERE job_id=applications.id AND version=? AND state='succeeded' AND source_exists=1 AND hard_gates_pass=1)",
    [jobId, version]);
  return Number(result.affectedRowCount) === 1;
}

async function setCurrentMaterial(env, jobId, version) {
  try { await tursoExecute(env, 'INSERT INTO material_current (job_id, material_version_id, version) SELECT id, id, version FROM material_versions WHERE job_id=? AND version=? AND state=\'succeeded\' AND source_exists=1 AND hard_gates_pass=1 AND artifact_prefix IS NOT NULL ON CONFLICT(job_id) DO NOTHING', [jobId, version]); } catch { return false; }
  const current = await getCurrentMaterial(env, jobId);
  return current?.version === version;
}

async function getMaterialPdfState(env, jobId, material, bucket) { try { const version=material?.version; const prefix=material?.artifact_prefix; const expected=new RegExp('^materials/'+String(jobId)+'/versions/'+String(version||'').toLowerCase()+'/attempt-[A-Za-z0-9_-]{1,80}$'); if (!version || !expected.test(prefix||'')) return {state:'pending',ready:false}; const rows=await tursoQuery(env, "SELECT r.state FROM render_jobs r WHERE r.material_version_id=?", [material.id]); if(rows.length!==1) return {state:rows.some(r=>r.state==='failed')?'failed':'pending',ready:false}; if(rows[0].state!=='succeeded'||!bucket?.head)return {state:rows[0].state==='failed'?'failed':'pending',ready:false}; const [a,b]=await Promise.all([bucket.head(prefix+'/resume.pdf'),bucket.head(prefix+'/cover_letter.pdf')]); return {state:a&&b?'available':'pending',ready:Boolean(a&&b)} } catch { return {state:'pending',ready:false}; } }

async function getCurrentMaterial(env, jobId) {
  const rows = await tursoQuery(env, 'SELECT mv.* FROM material_current mc JOIN material_versions mv ON mv.id=mc.material_version_id WHERE mc.job_id=? AND mv.state=\'succeeded\' AND mv.source_exists=1 AND mv.hard_gates_pass=1 LIMIT 1', [jobId]);
  return rows[0] || null;
}

async function markCurrentIfAbsent(env, jobId, version) {
  return setCurrentMaterial(env, jobId, version);
}

export { LEASE_SECONDS, getMaterialPdfState, ensureMaterialVersion, getMaterialVersion, claimMaterial, markMaterialSucceeded, markMaterialFailed, getCurrentSuccessfulMaterial, projectMaterialsReady, setCurrentMaterial, getCurrentMaterial, resetFailedMaterial };
