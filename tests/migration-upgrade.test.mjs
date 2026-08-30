import test from 'node:test'; import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises';
test('additive render upgrade is column-only',async()=>{const s=await readFile(new URL('../migrations/007_render_job_columns.sql',import.meta.url),'utf8'); assert.doesNotMatch(s,/CREATE TABLE.*render_jobs/s); assert.match(s,/ADD COLUMN retry_at/);});
