/**
 * Pure material lifecycle helpers. Material work is separate from application
 * progression: only a successful, complete source set may project
 * materials_ready onto an application.
 */

const MATERIAL_STATES = Object.freeze(['pending', 'claimed', 'succeeded', 'failed']);
const SOURCE_FILENAMES = Object.freeze({
  resume: 'resume.md',
  coverLetter: 'cover_letter.md',
  details: 'job_details.json',
  manifest: 'manifest.json'
});

function isMaterialState(state) {
  return typeof state === 'string' && MATERIAL_STATES.includes(state);
}

function dateValue(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : NaN;
}

function canClaim(material, now = Date.now()) {
  if (!material || material.state === 'pending') return true;
  return material.state === 'claimed' &&
    Number.isFinite(dateValue(material.lease_expires_at)) &&
    dateValue(material.lease_expires_at) <= now;
}

function isSuccessfulMaterial(material) {
  const sourceExists = material?.source_exists === true || material?.source_exists === 1;
  const gatesPass = material?.hard_gates_pass === true || material?.hard_gates_pass === 1;
  return Boolean(material) && material.state === 'succeeded' && sourceExists && gatesPass;
}

function hardGatesPass(quality) {
  return quality?.facts?.ok === true && quality?.atsPass === true;
}

function claimMatches(material, leaseToken, now = Date.now()) {
  return Boolean(material) &&
    material.state === 'claimed' &&
    typeof leaseToken === 'string' && leaseToken.length > 0 &&
    material.lease_token === leaseToken &&
    Number.isFinite(dateValue(material.lease_expires_at)) &&
    dateValue(material.lease_expires_at) > now;
}

function isCompleteSourceSet(objects) {
  return Boolean(objects?.resume && objects?.coverLetter && objects?.details && objects?.manifest);
}

/** Validate the immutable source manifest before terminal success or reuse. */
function validManifest(manifest, { jobId, version, hashes = null } = {}) {
  if (!manifest || typeof manifest !== 'object') return false;
  if (String(manifest.job_id) !== String(jobId) || String(manifest.version).toLowerCase() !== String(version).toLowerCase()) return false;
  if (!manifest.profile_revision || !manifest.template_revision || !manifest.renderer_revision) return false;
  const artifacts = manifest.artifacts;
  if (!artifacts || typeof artifacts !== 'object') return false;
  if (!/^[a-f0-9]{64}$/i.test(String(artifacts.resume || '')) ||
      !/^[a-f0-9]{64}$/i.test(String(artifacts.cover_letter || '')) ||
      !/^[a-f0-9]{64}$/i.test(String(artifacts.job_details || ''))) return false;
  return !hashes || (hashes.resume === artifacts.resume && hashes.cover_letter === artifacts.cover_letter && hashes.job_details === artifacts.job_details);
}

async function validateManifestBytes(manifest, bytes, identity) {
  if (!validManifest(manifest, identity)) return false;
  const hashes = { resume: await sha256Hex(bytes.resume), cover_letter: await sha256Hex(bytes.coverLetter), job_details: await sha256Hex(bytes.details) };
  return validManifest(manifest, { ...identity, hashes });
}

function currentKey(jobId) {
  if (!/^\d+$/.test(String(jobId))) throw new Error('Invalid job id');
  return 'materials/' + String(jobId) + '/current.json';
}

function normalizeForVersion(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable');
  const input = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof ArrayBuffer ? value : ArrayBuffer.isView(value) ? value : new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function versionFor({ normalizedJd, profileRevision, templateRevision = 'source-v1', rendererRevision = 'source-v1' }) {
  return sha256Hex([
    normalizedJd,
    profileRevision,
    templateRevision,
    rendererRevision
  ].map(normalizeForVersion).join('\n'));
}

function materialKeys(jobId, version) {
  if (!/^\d+$/.test(String(jobId)) || !/^[a-f0-9]{64}$/i.test(String(version))) {
    throw new Error('Invalid material key identity');
  }
  const prefix = 'materials/' + String(jobId) + '/versions/' + String(version).toLowerCase();
  return {
    resume: prefix + '/' + SOURCE_FILENAMES.resume,
    coverLetter: prefix + '/' + SOURCE_FILENAMES.coverLetter,
    details: prefix + '/' + SOURCE_FILENAMES.details,
    manifest: prefix + '/' + SOURCE_FILENAMES.manifest
  };
}

function legacyMaterialKeys(jobId) {
  if (!/^\d+$/.test(String(jobId))) throw new Error('Invalid job id');
  const prefix = 'materials/' + String(jobId);
  return {
    resume: prefix + '/resume.md',
    coverLetter: prefix + '/cover_letter.md',
    details: prefix + '/job_details.json'
  };
}

export {
  MATERIAL_STATES,
  SOURCE_FILENAMES,
  isMaterialState,
  canClaim,
  isSuccessfulMaterial,
  hardGatesPass,
  claimMatches,
  isCompleteSourceSet,
  normalizeForVersion,
  sha256Hex,
  versionFor,
  materialKeys,
  legacyMaterialKeys,
  validManifest,
  validateManifestBytes,
  currentKey
};
