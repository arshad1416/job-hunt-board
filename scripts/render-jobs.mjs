#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(nodeExecFile);
import { createR2S3 } from './lib/r2-s3.mjs';
import { loadTemplates, renderMaterials, renderPdf } from './materials-renderer.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromiumPath } from './materials-renderer.mjs';
import { tursoQuery, tursoExecute } from './lib/turso.mjs';
import { acquireFetchLock } from './lib/lock.mjs';
import { validateManifestBytes } from '../functions/_lib/material-state.js';
// Renderer callbacks receive canonical Markdown; CLI adapters may add details without changing source validation.

export const MAX_ATTEMPTS=3, LEASE_SECONDS=600;
export function createLocalPdfRenderer(env={}){const templates=loadTemplates(env.TEMPLATES_ROOT);return async(markdown,type,details={})=>{if(!['resume','cover_letter'].includes(type)||typeof markdown!=='string'||!details||typeof details!=='object'||Array.isArray(details)||!['name','email','phone','location'].every(k=>typeof details[k]==='string'&&details[k].trim()))return{ok:false,error:'renderer_input_incomplete'};const browser=env.CHROMIUM_BIN||chromiumPath();if(!browser)return{ok:false,error:'chromium_unavailable'};let dir;try{const data={...details,resume:{...details,markdown:type==='resume'?markdown:''},coverLetter:{...details,markdown:type==='cover_letter'?markdown:''}};const rendered=renderMaterials(data,templates);dir=fs.mkdtempSync(path.join(os.tmpdir(),'render-job-'));const destination=path.join(dir,'output.pdf');const pdf=renderPdf(type==='resume'?rendered.resume:rendered.cover,{type,browser,destination});if(!pdf.ok)return{ok:false,error:'pdf_render_failed',gates:pdf.gates};return{ok:true,body:new Uint8Array(fs.readFileSync(destination)),pages:pdf.pages,gates:pdf.gates,renderer_revision:rendered.revision};}catch{return{ok:false,error:'renderer_failed'};}finally{if(dir)fs.rmSync(dir,{recursive:true,force:true});}};}
export function createWranglerR2(env={}, runner=execFile){
  const bucket=env.R2_BUCKET;
  if(!bucket) throw new Error('R2_BUCKET is required');
  const run=(args)=>runner('wrangler',args,{cwd:env.WRANGLER_CWD||process.cwd(),env:{...process.env,...env}});
  const temp=async(body)=>{const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'wrangler-render-'));const file=path.join(dir,'payload');await fs.promises.writeFile(file,body instanceof Uint8Array?body:Buffer.from(body));return {dir,file};};
  return {get:async key=>{const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'wrangler-read-'));const file=path.join(dir,'payload');try{await run(['r2','object','get',`${bucket}/${key}`,'--file',file,'--remote']);const body=await fs.promises.readFile(file);return {arrayBuffer:async()=>new Uint8Array(body),text:async()=>body.toString()};}catch{return null;}finally{await fs.promises.rm(dir,{recursive:true,force:true});}},head:async key=>{const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'wrangler-head-'));try{await run(['r2','object','get',`${bucket}/${key}`,'--file',path.join(dir,'payload'),'--remote']);return true}catch{return false}finally{await fs.promises.rm(dir,{recursive:true,force:true});}},put:async(key,body)=>{const t=await temp(body);try{await run(['r2','object','put',`${bucket}/${key}`,'--file',t.file,'--content-type','application/pdf','--remote'])}finally{await fs.promises.rm(t.dir,{recursive:true,force:true})}},delete:async key=>{await run(['r2','object','delete',bucket+'/'+key,'--remote'])}};
}

export function retryAfter(attempt,now=Date.now()){return now+Math.min(3600000,1000*2**Math.max(0,attempt-1));}
export function claimable(job,now=Date.now()){return job&&job.attempt_count<MAX_ATTEMPTS&&((job.state==='pending'&&(!job.retry_at||Date.parse(job.retry_at)<=now))||(job.state==='failed'&&job.retry_at&&Date.parse(job.retry_at)<=now)||(job.state==='claimed'&&Date.parse(job.lease_expires_at)<=now));}
export function claimSql(){return "UPDATE render_jobs SET state='claimed',lease_token=?,lease_expires_at=?,attempt_count=attempt_count+1 WHERE id=? AND (state='pending' OR (state='failed' AND retry_at<=datetime('now')) OR (state='claimed' AND datetime(lease_expires_at)<=datetime('now'))) AND attempt_count<?"}
export async function processRenderJob(row, { env, dryRun = false, execute = tursoExecute, query = tursoQuery, bucket, renderer } = {}) {
  if (dryRun) return { id: row.id, state: row.state, dryRun: true };
  const { id, job_id: jobId, version, lease_token: token, lease_expires_at: expiry, attempt_count: attempt } = row;
  const prefix = String(row.source_artifact_prefix || '');
  // Attempt-unique prefixes remain immutable while this lease is active.
  const parts = prefix.split('/');
  const validPrefix = row.document === 'pair' && parts.length === 5 && parts[0] === 'materials' && parts[1] === String(jobId) && parts[2] === 'versions' && parts[3] === String(version).toLowerCase() && parts[4] === `attempt-${token}` && /^[A-Za-z0-9_-]{1,80}$/.test(token) && /^\d+$/.test(parts[1]) && /^[a-f0-9]{64}$/.test(parts[3]);
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
  if (!prefix) return terminal(false, 'source_prefix_missing');
  if (!validPrefix) return terminal(false, 'source_prefix_invalid');
  try {
    const read = async (name) => { await leaseLive(); const object = await bucket.get(prefix + '/' + name); if (!object) throw new Error('source_missing'); return object.arrayBuffer ? new Uint8Array(await object.arrayBuffer()) : new TextEncoder().encode(await object.text()); };
    const [manifestBytes, resume, coverLetter, details] = await Promise.all(['manifest.json', 'resume.md', 'cover_letter.md', 'job_details.json'].map(read));
    let manifest; try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); } catch { throw new Error('manifest_invalid'); }
    if (!await validateManifestBytes(manifest, { resume, coverLetter, details }, { jobId, version })) throw new Error('source_tampered');
    const [resumePdf, coverPdf] = await Promise.all([renderer(new TextDecoder().decode(resume), 'resume', JSON.parse(new TextDecoder().decode(details))), renderer(new TextDecoder().decode(coverLetter), 'cover_letter', JSON.parse(new TextDecoder().decode(details)))]);
    if (!resumePdf?.ok || !coverPdf?.ok) throw new Error('pdf_gates_failed');
    const staged = [[resumePdf, 'resume.pdf'], [coverPdf, 'cover_letter.pdf']];
    await leaseLive();
    for (const [, name] of staged) { await leaseLive(); if (bucket.head && await bucket.head(prefix + '/' + name)) throw new Error('pdf_exists'); }
    const uploaded = [];
    try {
      for (const [pdf, name] of staged) { const key = prefix + '/' + name; await leaseLive(); uploaded.push(key); await bucket.put(key, pdf.body, { onlyIfNew: true });
        await leaseLive(); }
    } catch (error) {
      if (bucket.delete) for (const key of uploaded) { try { await bucket.delete(key); } catch {} }
      throw error;
    }
    const bytes = body => body instanceof Uint8Array ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : new TextEncoder().encode(String(body));
    const digest = async body => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(body)))].map(b => b.toString(16).padStart(2, '0')).join('');
    const resumeHash = await digest(resumePdf.body), coverHash = await digest(coverPdf.body);
    const metadata = await execute(env, "UPDATE render_jobs SET resume_pdf_sha256=?, cover_letter_pdf_sha256=?, resume_pdf_bytes=?, cover_letter_pdf_bytes=? WHERE id=? AND state='claimed' AND lease_token=? AND attempt_count=?", [resumeHash, coverHash, resumePdf.body?.byteLength || 0, coverPdf.body?.byteLength || 0, id, token, attempt]);
    if (Number(metadata?.affectedRowCount) !== 1) { if (bucket.delete) for (const key of uploaded) { try { await bucket.delete(key); } catch {} } return { id, state: 'stale' }; }
    try { await leaseLive(); } catch (error) { if (error.message === 'lease_stale') { if (bucket.delete) for (const key of uploaded) { try { await bucket.delete(key); } catch {} } return { id, state: 'stale' }; } throw error; }
    return terminal(true);
  } catch (error) { if (error.message === 'lease_stale') return { id, state: 'stale' }; return terminal(false, error.message); }
}
export async function pollRenderJobs({env,dryRun=false,limit=10,query=tursoQuery,execute=tursoExecute}={}){
  const lock=acquireFetchLock('render-jobs',{startedAtMs:Date.now()});
  if(!lock.ok) return {dryRun,claimed:[],error:'lock_unavailable'};
  try {const rows=await query(env,"SELECT r.*,m.job_id,m.version,r.source_artifact_prefix FROM render_jobs r JOIN material_versions m ON m.id=r.material_version_id WHERE (r.state='pending' OR (r.state='failed' AND r.retry_at<=datetime('now')) OR (r.state='claimed' AND datetime(r.lease_expires_at) <= datetime('now'))) AND r.attempt_count<? ORDER BY r.created_at LIMIT ?",[MAX_ATTEMPTS,Math.min(50,Math.max(1,limit))]);if(dryRun)return{dryRun:true,count:rows.length,rows};const claimed=[];for(const row of rows){const token=randomUUID(),leaseExpires=new Date(Date.now()+LEASE_SECONDS*1000).toISOString(),result=await execute(env,claimSql(),[token,leaseExpires,row.id,MAX_ATTEMPTS]);if(Number(result?.affectedRowCount)===1){const claimedRows=await query(env,'SELECT * FROM render_jobs WHERE id=?',[row.id]);const persisted=claimedRows[0];if(persisted)claimed.push({...row,...persisted,source_artifact_prefix:row.source_artifact_prefix})}}return{dryRun:false,claimed};
  } finally { lock.release(); } }
export async function runWorker(options={}){const args=options.args||{dryRun:true,limit:10};const result=await pollRenderJobs({env:options.env||process.env,...args,query:options.query,execute:options.execute});if(args.dryRun)return result;if(!options.bucket||!options.renderer)throw new Error('bucket and renderer adapters are required');const results=[];for(const row of result.claimed)results.push(await processRenderJob(row,{env:options.env||process.env,bucket:options.bucket,renderer:options.renderer,query:options.query,execute:options.execute}));return {...result,results,ok:results.length===result.claimed.length&&results.every(x=>x.state==='succeeded')}}
export function parseWorkerArgs(argv=[]){const out={dryRun:true,limit:10};for(let i=0;i<argv.length;i++){if(argv[i]==='--dry-run')out.dryRun=true;else if(argv[i]==='--no-dry-run'||argv[i]==='--execute')out.dryRun=false;else if(argv[i]==='--limit'){const n=Number(argv[++i]);if(!Number.isInteger(n)||n<1||n>50)throw new Error('invalid --limit');out.limit=n}else if(argv[i]==='--transport'){const transport=argv[++i];if(!['s3','wrangler'].includes(transport))throw new Error('invalid --transport');out.transport=transport}else throw new Error('unknown argument '+argv[i])}return out}
if(import.meta.url===`file://${process.argv[1]}`){try{const args=parseWorkerArgs(process.argv.slice(2)),env=process.env;if(!env.TURSO_URL||!env.TURSO_TOKEN)throw new Error('TURSO_URL and TURSO_TOKEN are required');if(!args.dryRun){if(args.transport!=='wrangler')for(const k of ['R2_ENDPOINT','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET'])if(!env[k])throw new Error('missing '+k);if(!env.R2_BUCKET)throw new Error('missing R2_BUCKET');if(!chromiumPath())throw new Error('chromium unavailable')}const options={env,args};if(!args.dryRun){options.bucket=args.transport==='wrangler'?createWranglerR2(env):createR2S3(env);options.renderer=createLocalPdfRenderer(env)}runWorker(options).then(x=>{console.log(JSON.stringify({dryRun:x.dryRun,count:x.count??x.claimed?.length??0,results:x.results?.map(r=>({id:r.id,state:r.state}))??[]}));if(x.ok===false)process.exitCode=1}).catch(e=>{console.error(e.message);process.exitCode=1})}catch(e){console.error(e.message);process.exitCode=1}}