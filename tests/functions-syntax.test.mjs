import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// V8 syntax sweep over everything Pages bundles. A single bad file fails the
// deploy at the bundler while every other test stays green (observed: an
// invalid object literal in generate-status.js froze production at an old
// build with no local signal).
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : (p.endsWith('.js') || p.endsWith('.mjs') ? [p] : []);
});
const files = walk('functions');
test('every Pages Functions file parses', () => {
  assert.ok(files.length > 5, 'functions sweep found nothing');
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, f + ': ' + (r.stderr || '').slice(0, 200));
  }
});
