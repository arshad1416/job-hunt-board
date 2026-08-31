#!/usr/bin/env node
/** Deterministic, bounded operational summary; never emits document text or raw errors. */
import fs from 'node:fs';
import { tursoQuery } from './lib/turso.mjs';

export const MAX_ROWS = 1000;
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const bucket = (rows, key) => rows.reduce((a, r) => { const k = String(r[key] ?? 'unknown').slice(0, 40); a[k] = (a[k] || 0) + 1; return a; }, {});
export function summarize(input = {}) {
  const cap = (x) => Array.isArray(x) ? x.slice(0, MAX_ROWS) : [];
  const gen = cap(input.generation_jobs), render = cap(input.render_jobs), mats = cap(input.material_versions);
  const latency = rows => { const values = rows.map(r => num(r.duration_ms ?? r.latency_ms)).filter(x => x >= 0).sort((a,b)=>a-b); return { count: values.length, min_ms: values[0] ?? 0, max_ms: values.at(-1) ?? 0, avg_ms: values.length ? Math.round(values.reduce((a,b)=>a+b,0)/values.length) : 0 }; };
  const failures = rows => rows.filter(r => ['failed','error'].includes(String(r.state ?? r.status))).length;
  return { generated_at: input.generated_at || 'deterministic', bounded: true,
    generation: { latency: latency(gen), failures: failures(gen), reuse: gen.filter(r=>r.reused_from_job_id != null || r.reused === true).length },
    render: { latency: latency(render), failures: failures(render), queue_depth: render.filter(r=>['pending','claimed'].includes(r.state)).length, states: bucket(render,'state') },
    quality_gate: bucket(mats,'hard_gates_pass'), jd_source: bucket(gen,'jd_source'),
    stale_lease: { materials: mats.filter(r=>r.state==='claimed' && r.lease_expires_at && Date.parse(r.lease_expires_at) < (input.now_ms ?? Date.now())).length, render_jobs: render.filter(r=>r.state==='claimed' && r.lease_expires_at && Date.parse(r.lease_expires_at) < (input.now_ms ?? Date.now())).length },
    counts: { generation: gen.length, render: render.length, materials: mats.length }
  };
}
export async function loadReport({ env = process.env, query = tursoQuery, input } = {}) {
  if (input) return summarize(input);
  const [generation_jobs, render_jobs, material_versions] = await Promise.all([
    query(env, 'SELECT state, duration_ms, reused_from_job_id, jd_source FROM generation_jobs ORDER BY id DESC LIMIT ?', [MAX_ROWS]).catch(()=>[]),
    query(env, 'SELECT state, duration_ms, lease_expires_at FROM render_jobs ORDER BY id DESC LIMIT ?', [MAX_ROWS]),
    query(env, 'SELECT state, hard_gates_pass, lease_expires_at FROM material_versions ORDER BY id DESC LIMIT ?', [MAX_ROWS])
  ]);
  return summarize({ generation_jobs, render_jobs, material_versions });
}
export function selfTest() { const r = summarize({ now_ms: 2000, generation_jobs:[{duration_ms:10,state:'succeeded',reused:true,jd_source:'ats'}], render_jobs:[{state:'pending',duration_ms:20},{state:'claimed',lease_expires_at:'1970-01-01T00:00:01Z'}], material_versions:[{hard_gates_pass:1,state:'claimed',lease_expires_at:'1970-01-01T00:00:01Z'}]}); if(r.generation.reuse!==1||r.render.queue_depth!==2||r.stale_lease.render_jobs!==1) throw new Error('health self-test failed'); return r; }
if (import.meta.url === 'file://' + process.argv[1]) { try { const args=process.argv.slice(2); if(args.includes('--self-test')) console.log(JSON.stringify(selfTest(),null,2)); else console.log(JSON.stringify(await loadReport(),null,2)); } catch { console.error('health report unavailable'); process.exitCode=1; } }
