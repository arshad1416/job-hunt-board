import { tursoQuery, tursoExecute } from './turso.js';

const LEASE_SECONDS = 300;
const MAX_ERROR_LENGTH = 240;

function secureToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error('Secure random UUID is unavailable');
}

function boundedError(value) {
  return String(value || 'material operation failed').replace(/[\r\n]+/g, ' ').slice(0, MAX_ERROR_LENGTH);
}

async function ensureMaterialVersion(env, { jobId, version, reusedFromJobId = null }) {
  try {
    await tursoExecute(env,
      'INSERT INTO material_versions (job_id, version, reused_from_job_id) VALUES (?, ?, ?) ON CONFLICT(job_id, version) DO NOTHING',
      [jobId, version, reusedFromJobId]);
  } catch (error) {
    if (!/unique|constraint/i.test(String(error?.message || ''))) throw error;
  }
  return getMaterialVersion(env, jobId, version);
}

async function getMaterialVersion(env, jobId, version) {
  const rows = await tursoQuery(env,
    'SELECT * FROM material_versions WHERE job_id=? AND version=? LIMIT 1',
    [jobId, version]);
  return rows[0] || null;
}

async function claimMaterial(env, { jobId, version, leaseSeconds = LEASE_SECONDS, leaseToken = secureToken() }) {
  const result = await tursoExecute(env,
    "UPDATE material_versions SET state='claimed', lease_token=?, lease_expires_at=datetime('now', '+' || ? || ' seconds'), attempt_count=attempt_count+1, updated_at=datetime('now'), error_code=NULL, error_message=NULL WHERE job_id=? AND version=? AND (state='pending' OR (state='claimed' AND lease_expires_at <= datetime('now')))",
    [leaseToken, leaseSeconds, jobId, version]);
  return { claimed: Number(result.affectedRowCount) === 1, leaseToken };
}

async function markMaterialSucceeded(env, { jobId, version, leaseToken, artifactPrefix, sourceExists = true, hardGatesPass = true }) {
  if (!sourceExists || !hardGatesPass || !leaseToken || !artifactPrefix) return false;
  const result = await tursoExecute(env,
    "UPDATE material_versions SET state='succeeded', source_exists=1, hard_gates_pass=1, artifact_prefix=?, lease_token=NULL, lease_expires_at=NULL, completed_at=datetime('now'), updated_at=datetime('now') WHERE job_id=? AND version=? AND state='claimed' AND lease_token=? AND lease_expires_at > datetime('now')",
    [artifactPrefix || null, jobId, version, leaseToken]);
  return result.affectedRowCount === 1;
}

async function markMaterialFailed(env, { jobId, version, leaseToken, errorCode = 'material_failed', errorMessage }) {
  if (!leaseToken) return false;
  const result = await tursoExecute(env,
    "UPDATE material_versions SET state='failed', source_exists=0, hard_gates_pass=0, error_code=?, error_message=?, lease_token=NULL, lease_expires_at=NULL, updated_at=datetime('now') WHERE job_id=? AND version=? AND state='claimed' AND lease_token=?",
    [String(errorCode).slice(0, 80), boundedError(errorMessage || errorCode), jobId, version, leaseToken]);
  return result.affectedRowCount === 1;
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
  return result.affectedRowCount === 1;
}

export { LEASE_SECONDS, ensureMaterialVersion, getMaterialVersion, claimMaterial, markMaterialSucceeded, markMaterialFailed, getCurrentSuccessfulMaterial, projectMaterialsReady };
