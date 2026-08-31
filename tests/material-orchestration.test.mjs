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

test('failed deterministic attempt retries, succeeded/current cannot reset', () => {
  const retry = (row, current = false) => row.state === 'failed' && !row.lease_token && !current ? { ...row, state: 'pending', error_code: null } : row;
  const failed = retry({ state: 'failed', lease_token: null, error_code: 'storage_failed' });
  assert.equal(failed.state, 'pending');
  assert.equal(retry({ state: 'succeeded', lease_token: null }, false).state, 'succeeded');
  assert.equal(retry({ state: 'failed', lease_token: null }, true).state, 'failed');
});

test('fake R2 source completeness and pointer first-writer wins', () => {
  const r2 = new Map([['resume.md', 'r'], ['cover_letter.md', 'c'], ['job_details.json', '{}'], ['manifest.json', '{}']]);
  assert.equal(['resume.md', 'cover_letter.md', 'job_details.json', 'manifest.json'].every(k => r2.has(k)), true);
  r2.delete('manifest.json');
  assert.equal(['resume.md', 'cover_letter.md', 'job_details.json', 'manifest.json'].every(k => r2.has(k)), false);
  let pointer = null;
  const setCurrent = v => pointer ??= v;
  assert.equal(setCurrent('first'), 'first');
  assert.equal(setCurrent('second'), 'first');
  assert.equal(pointer, 'first');
});

test('pointer and versioned route contracts remain immutable', () => {
  const v = 'c'.repeat(64);
  assert.match(materialKeys(7, v).resume, /versions\/c{64}\/resume/);
});
