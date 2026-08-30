import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const script = path.resolve('scripts/preflight.mjs');
test('preflight redacts values and fails missing configuration', () => {
  const r = spawnSync(process.execPath, [script, '--json'], { env: {}, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout), { ok: false, checks: { TURSO_URL:false, TURSO_TOKEN:false, NINEROUTER_API_KEY:false, DASHBOARD_AUTH_TOKEN:false, JOB_MATERIALS_BUCKET:false } });
  assert.doesNotMatch(r.stdout, /secret|token-value/i);
});
test('preflight succeeds with required configuration', () => {
  const env = { TURSO_URL:'https://example.test', TURSO_TOKEN:'secret', NINEROUTER_API_KEY:'secret', DASHBOARD_AUTH_TOKEN:'secret', JOB_MATERIALS_BUCKET:'bucket' };
  const r = spawnSync(process.execPath, [script, '--json'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).ok, true); assert.doesNotMatch(r.stdout, /secret/);
});
