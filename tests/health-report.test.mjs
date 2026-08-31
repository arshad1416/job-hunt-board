import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, selfTest, MAX_ROWS } from '../scripts/health-report.mjs';
test('self-test deterministic',()=>assert.deepEqual(selfTest(),selfTest()));
test('bounded injected rows',()=>{const r=summarize({render_jobs:Array.from({length:MAX_ROWS+10},()=>({state:'pending'}))});assert.equal(r.counts.render,MAX_ROWS);assert.equal(r.render.queue_depth,MAX_ROWS);});
test('stale lease summary',()=>assert.equal(summarize({now_ms:2000,render_jobs:[{state:'claimed',lease_expires_at:'1970-01-01T00:00:01Z'}]}).stale_lease.render_jobs,1));
