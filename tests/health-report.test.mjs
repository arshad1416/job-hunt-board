import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, selfTest, MAX_ROWS, retentionGuard, loadReport } from '../scripts/health-report.mjs';
test('self-test deterministic',()=>assert.deepEqual(selfTest(),selfTest()));
test('bounded injected rows',()=>{const r=summarize({render_jobs:Array.from({length:MAX_ROWS+10},()=>({state:'pending'}))});assert.equal(r.counts.render,MAX_ROWS);assert.equal(r.render.queue_depth,MAX_ROWS);});
test('stale lease summary',()=>assert.equal(summarize({now_ms:2000,render_jobs:[{state:'claimed',lease_expires_at:'1970-01-01T00:00:01Z'}]}).stale_lease.render_jobs,1));
test('retention guard never selects current',()=>{assert.equal(retentionGuard({versionedArtifactsLive:false,currentVersion:'v1',requestedVersions:['v2']}).allowed,false);assert.equal(retentionGuard({versionedArtifactsLive:true,currentVersion:'v1',requestedVersions:['v2']}).allowed,true);assert.equal(retentionGuard({versionedArtifactsLive:true,currentVersion:'v1',requestedVersions:['v1']}).allowed,false);});
test('adapter tolerates schema/query failures',async()=>{const r=await loadReport({query:async()=>{throw new Error('secret');}});assert.equal(r.bounded,true);});
