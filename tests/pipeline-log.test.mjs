import assert from 'node:assert/strict';
import test from 'node:test';
import { logPipelineStage, pipelineStage } from '../functions/_lib/pipeline-log.js';

test('pipeline logger emits only safe scalar fields', () => {
  const lines = []; const original = console.log; console.log = value => lines.push(value);
  try { logPipelineStage('load', { job_id: '7', secret: 'nope', nested: {}, status: 'ok' }); } finally { console.log = original; }
  assert.deepEqual(JSON.parse(lines[0]), { event: 'pipeline_stage', job_id: '7', status: 'ok', stage: 'load' });
});

test('pipelineStage records output status and duration', () => {
  const lines = []; const original = console.log; console.log = value => lines.push(JSON.parse(value));
  try { pipelineStage('write', { job_id: '2' })({ status: 'completed' }); } finally { console.log = original; }
  assert.equal(lines[0].stage, 'write'); assert.equal(lines[0].status, 'completed'); assert.equal(typeof lines[0].duration_ms, 'number');
});
