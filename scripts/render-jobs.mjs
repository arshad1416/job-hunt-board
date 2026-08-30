#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { tursoQuery, tursoExecute } from './lib/turso.mjs';
import { acquireFetchLock } from './lib/lock.mjs';
import { validateManifestBytes } from '../functions/_lib/material-state.js';
export const MAX_ATTEMPTS=3, LEASE_SECONDS=600;
export function retryAfter(attempt,now=Date.now()){return now+Math.min(3600000,1000*2**Math.max(0,attempt-1));}
export function claimable(job,now=Date.now()){return job&&job.attempt_count<MAX_ATTEMPTS&&((job.state==='pending'&&(!job.retry_at||Date.parse(job.retry_at)<=now))||(job.state==='failed'&&job.retry_at&&Date.parse(job.retry_at)<=now)||(job.state==='claimed'&&Date.parse(job.lease_expires_at)<=now));}
export function claimSql(){return "UPDATE render_jobs SET state='claimed',lease_token=?,lease_expires_at=datetime('now','+' || ? || ' seconds'),attempt_count=attempt_count+1 WHERE id=? AND (state='pending' OR (state='failed' AND retry_at<=datetime('now')) OR (state='claimed' AND lease_expires_at<=datetime('now'))) AND attempt_count<?"}
export async function processRenderJob(row, { env, dryRun = false, execute = tursoExecute, query = tursoQuery, bucket, renderer } = {}) {
  if (dryRun) return { id: row.id, state: row.state, dryRun: true };
  const { id, job_id: jobId, version, lease_token: token, lease_expires_at: expiry, attempt_count: attempt } = row;
  const prefix = String(row.artifact_prefix || '');
  const parts = prefix.split('/');
  const validPrefix = parts.length === 5 && parts[0] === 'materials' && parts[1] === String(jobId) && parts[2] === 'versions' && parts[3] === String(version).toLowerCase() && parts[4] === `attempt-${token}` && /^[A-Za-z0-9_-]{1,80}$/.test(token) && /^\d+$/.test(parts[1]) && /^[a-f0-9]{64}$/.test(parts[3]);
  const leaseLive = async () => {
    if (bucket?.checkLease) {
      if (!(await bucket.checkLease(row))) throw new Error('lease_stale');
      return true;
    }
    const rows = await query(env, "SELECT 1 FROM render_jobs WHERE id=? AND state='claimed' AND lease_token=? AND lease_expires_at=? AND attempt_count=?", [id, token, expiry, attempt]);
    if (!rows?.length) throw new Error('lease_stale');
    return true;
  };
  const terminal = async (ok, message = '') => {
    try { await leaseLive(); } catch (e) { if (e.message === 'lease_stale') return { id, state: 'stale' }; throw e; }
    const error = String(message).replace(/[\r\n]+/g, ' ').slice(0, 120);
    const max = Number(attempt) >= MAX_ATTEMPTS;
    const failureRetry = max ? 'NULL' : "datetime('now','+' || ? || ' seconds')";
    const failureCompleted = max ? "datetime('now')" : 'NULL';
    const sql = ok ? "UPDATE render_jobs SET state='succeeded',completed_at=datetime('now'),error_code=NULL,retry_at=NULL,lease_token=NULL WHERE id=? AND state='claimed' AND lease_token=? AND lease_expires_at=? AND attempt_count=?" : "UPDATE render_jobs SET state='failed',error_code=?,retry_at=" + failureRetry + ",completed_at=" + failureCompleted + ",lease_token=NULL WHERE id=? AND state='claimed' AND lease_token=? AND lease_expires_at=? AND attempt_count=?";
    const args = ok ? [id, token, expiry, attempt] : max ? [error, id, token, expiry, attempt] : [error, Math.min(3600, 2 ** Math.max(0, attempt - 1)), id, token, expiry, attempt];
    try { const result = await execute(env, sql, args); return { id, state: Number(result?.affectedRowCount) === 1 ? (ok ? 'succeeded' : 'failed') : 'stale' }; } catch { return { id, state: 'stale' }; }
  };
  if (!validPrefix) return terminal(false, 'source_prefix_invalid');
  try {
    const read = async (name) => { await leaseLive(); const object = await bucket.get(prefix + '/' + name); if (!object) throw new Error('source_missing'); return object.arrayBuffer ? new Uint8Array(await object.arrayBuffer()) : new TextEncoder().encode(await object.text()); };
    const [manifestBytes, resume, coverLetter, details] = await Promise.all(['manifest.json', 'resume.md', 'cover_letter.md', 'job_details.json'].map(read));
    let manifest; try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); } catch { throw new Error('manifest_invalid'); }
    if (!await validateManifestBytes(manifest, { resume, coverLetter, details }, { jobId, version })) throw new Error('source_tampered');
    const [resumePdf, coverPdf] = await Promise.all([renderer(new TextDecoder().decode(resume), 'resume'), renderer(new TextDecoder().decode(coverLetter), 'cover_letter')]);
    if (!resumePdf?.ok || !coverPdf?.ok) throw new Error('pdf_gates_failed');
    const staged = [[resumePdf, 'resume.pdf'], [coverPdf, 'cover_letter.pdf']];
    await leaseLive();
    for (const [, name] of staged) { await leaseLive(); if (bucket.head && await bucket.head(prefix + '/' + name)) throw new Error('pdf_exists'); }
    const uploaded = [];
    try {
      for (const [pdf, name] of staged) { await leaseLive(); await bucket.put(prefix + '/' + name, pdf.body, { onlyIfNew: true }); uploaded.push(prefix + '/' + name); }
    } catch (error) {
      if (bucket.delete) for (const key of uploaded) { try { await bucket.delete(key); } catch {} }
      throw error;
    }
    return terminal(true);
  } catch (error) { if (error.message === 'lease_stale') return { id, state: 'stale' }; return terminal(false, error.message); }
}
export async function pollRenderJobs({env,dryRun=false,limit=10,query=tursoQuery,execute=tursoExecute}={}){
  const lock=acquireFetchLock('render-jobs',{startedAtMs:Date.now()});
  if(!lock.ok) return {dryRun,claimed:[],error:'lock_unavailable'};
  try {const rows=await query(env,"SELECT r.*,m.job_id,m.version,r.source_artifact_prefix FROM render_jobs r JOIN material_versions m ON m.id=r.material_version_id WHERE (r.state='pending' OR (r.state='failed' AND r.retry_at<=datetime('now')) OR (r.state='claimed' AND r.lease_expires_at<=datetime('now'))) AND r.attempt_count<? ORDER BY r.created_at LIMIT ?",[MAX_ATTEMPTS,Math.min(50,Math.max(1,limit))]);if(dryRun)return{dryRun:true,count:rows.length,rows};const claimed=[];for(const row of rows){const token=randomUUID(),result=await execute(env,claimSql(),[token,LEASE_SECONDS,row.id,MAX_ATTEMPTS]);if(Number(result?.affectedRowCount)===1)claimed.push({...row,lease_token:token})}return{dryRun:false,claimed};
  } finally { lock.release(); } }