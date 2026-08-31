import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { stepLog } from '../functions/_lib/pipeline-log.js';
test('profile contact extraction is represented in job details source', () => { const source = fs.readFileSync(new URL('../functions/api/generate.js', import.meta.url), 'utf8'); assert.match(source, /profileContact\(materials\.profileYaml\)/); assert.match(source, /name:|email:|phone:|location:/); });

test('stepLog emits exact structured shape', () => { const lines=[]; const old=console.log; console.log=x=>lines.push(JSON.parse(x)); try { stepLog('load',{job_id:'7',cached:true}); } finally { console.log=old; } assert.equal(lines.length,1); assert.equal(lines[0].step,'load'); assert.equal(lines[0].job_id,'7'); assert.equal(lines[0].cached,true); assert.match(lines[0].ts,/^\d{4}-\d{2}-\d{2}T/); });
