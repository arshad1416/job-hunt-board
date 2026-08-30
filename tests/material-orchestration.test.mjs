import test from 'node:test';
import assert from 'node:assert/strict';
import { canClaim, claimMatches, isCompleteSourceSet, validManifest, validateManifestBytes, materialKeys } from '../functions/_lib/material-state.js';

test('claim race and stale lease fencing', () => {
  assert.equal(canClaim({ state: 'claimed', lease_expires_at: '2020-01-01T00:00:00Z' }, Date.now()), true);
  assert.equal(claimMatches({ state: 'claimed', lease_token: 'a', lease_expires_at: '2999-01-01T00:00:00Z' }, 'b'), false);
});

test('partial sources, gates, and manifest hashes fail closed', async () => {
  assert.equal(isCompleteSourceSet({ resume: {}, coverLetter: {}, details: {} }), false);
  assert.equal(isCompleteSourceSet({ resume: {}, coverLetter: {}, details: {}, manifest: {} }), true);
  const version = 'b'.repeat(64), bytes = { resume: 'r', coverLetter: 'c', details: 'd' };
  const hash = async x => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const manifest = { job_id: 7, version, profile_revision: 'p', template_revision: 't', renderer_revision: 'r', artifacts: { resume: await hash('r'), cover_letter: await hash('c'), job_details: await hash('d') } };
  assert.equal(validManifest(manifest, { jobId: 7, version }), true);
  assert.equal(await validateManifestBytes(manifest, bytes, { jobId: 7, version }), true);
  assert.equal(await validateManifestBytes(manifest, { ...bytes, details: 'x' }, { jobId: 7, version }), false);
});

test('pointer and versioned route contracts remain immutable', () => {
  const v = 'c'.repeat(64);
  assert.match(materialKeys(7, v).resume, /versions\/c{64}\/resume/);
});
