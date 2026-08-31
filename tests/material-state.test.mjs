import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIAL_STATES,
  isMaterialState,
  canClaim,
  isSuccessfulMaterial,
  claimMatches,
  materialKeys,
  legacyMaterialKeys,
  validManifest,
  validateManifestBytes
} from '../functions/_lib/material-state.js';

const now = Date.parse('2026-01-01T00:00:00Z');

 test('material states are explicit and success requires complete, gated sources', () => {
  assert.deepEqual(MATERIAL_STATES, ['pending', 'claimed', 'succeeded', 'failed']);
  assert.equal(isMaterialState('succeeded'), true);
  assert.equal(isMaterialState('materials_ready'), false);
  assert.equal(isSuccessfulMaterial({ state: 'succeeded', source_exists: true, hard_gates_pass: true }), true);
  for (const material of [
    { state: 'succeeded', source_exists: false, hard_gates_pass: true },
    { state: 'succeeded', source_exists: true, hard_gates_pass: false },
    { state: 'failed', source_exists: true, hard_gates_pass: true }
  ]) assert.equal(isSuccessfulMaterial(material), false);
});

test('only pending or expired claims can be recovered', () => {
  assert.equal(canClaim(null, now), true);
  assert.equal(canClaim({ state: 'pending' }, now), true);
  assert.equal(canClaim({ state: 'claimed', lease_expires_at: '2026-01-01T00:00:01Z' }, now), false);
  assert.equal(canClaim({ state: 'claimed', lease_expires_at: '2025-12-31T23:59:59Z' }, now), true);
  assert.equal(canClaim({ state: 'succeeded' }, now), false);
  assert.equal(canClaim({ state: 'failed' }, now), false);
});

test('lease token fences stale workers and keys are versioned', () => {
  const claimed = {
    state: 'claimed',
    lease_token: 'current',
    lease_expires_at: '2026-01-01T00:00:01Z'
  };
  assert.equal(claimMatches(claimed, 'current', now), true);
  assert.equal(claimMatches(claimed, 'stale', now), false);
  assert.equal(claimMatches({ ...claimed, lease_expires_at: '2025-12-31T23:59:59Z' }, 'current', now), false);
  const version = 'a'.repeat(64);
  assert.deepEqual(materialKeys(42, version), {
    resume: `materials/42/versions/${version}/resume.md`,
    coverLetter: `materials/42/versions/${version}/cover_letter.md`,
    details: `materials/42/versions/${version}/job_details.json`,
    manifest: `materials/42/versions/${version}/manifest.json`
  });
  assert.deepEqual(legacyMaterialKeys(42), {
    resume: 'materials/42/resume.md',
    coverLetter: 'materials/42/cover_letter.md',
    details: 'materials/42/job_details.json'
  });
});
