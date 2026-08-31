import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const generatePath = new URL('../functions/api/generate.js', import.meta.url);
const source = await readFile(generatePath, 'utf8');

test('material lookup failure is converted to JSON 503', async () => {
  assert.match(source, /try \{\s*existingCurrent = await getCurrentMaterial\(env, jobId\);/);
  assert.match(source, /return json\(\{ error: 'Material state unavailable' \}, 503\)/);
  assert.match(source, /const materials = await signedMaterialUrls/);
});

test('Workers byte counting uses TextEncoder and deployed functions contain no Buffer references', () => {
  assert.match(source, /new TextEncoder\(\)\.encode\(text\)\.length/);
  assert.doesNotMatch(source, /\bBuffer\./);
});
