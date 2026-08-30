import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {execFileSync} from 'node:child_process';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function safeMarkdown(input) {
  const text = String(input ?? '').replace(/<[^>]*>/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  return text.split(/\r?\n/).map(line => {
    const t=line.trim(); if (!t) return '';
    const h=t.match(/^(#{1,3})\s+(.+)$/); if(h) return '<h'+h[1].length+'>'+inline(h[2])+'</h'+h[1].length+'>';
    const li=t.match(/^[-*+]\s+(.+)$/); if(li) return '<li>'+inline(li[1])+'</li>';
    return '<p>'+inline(t)+'</p>';
  }).join('').replace(/(?:<li>.*?<\/li>)+/g, m => '<ul>'+m+'</ul>');
}
function inline(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_]+)__/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>').replace(/_([^_]+)_/g,'<em>$1</em>'); }
function validate(data) { if (!data || typeof data !== 'object') throw new Error('materials must be an object'); return data; }
export function renderMaterials(data, templates={}) {
  validate(data); const resume = data.resume ?? data; const cover = data.coverLetter ?? data.cover ?? {};
  const model={name:esc(resume.name||data.name), email:esc(resume.email||data.email), phone:esc(resume.phone||data.phone), location:esc(resume.location||data.location), resume: safeMarkdown(resume.markdown||resume.content||''), cover: safeMarkdown(cover.markdown||cover.content||'')};
  const r=(templates.resume||'').replaceAll('{{name}}',model.name).replaceAll('{{email}}',model.email).replaceAll('{{phone}}',model.phone).replaceAll('{{location}}',model.location).replaceAll('{{resume}}',model.resume);
  const c=(templates.cover||'').replaceAll('{{name}}',model.name).replaceAll('{{email}}',model.email).replaceAll('{{phone}}',model.phone).replaceAll('{{location}}',model.location).replaceAll('{{cover}}',model.cover);
  if (/{{[^}]+}}/.test(r+c)) throw new Error('unresolved placeholders');
  return {resume:r, cover:c, revision:crypto.createHash('sha256').update(r+'\0'+c).digest('hex')};
}
export function hardGates({type, text='', pages, tofu=false, overflow=false, clipped=false, orphanHeading=false, networkRequests=0}={}) {
  const max=type==='resume'?2:1; const failures=[]; if(!text.trim()) failures.push('missing extracted text'); if(tofu) failures.push('tofu'); if(overflow) failures.push('overflow'); if(clipped) failures.push('clipped content'); if(orphanHeading) failures.push('orphan heading'); if(networkRequests) failures.push('network requests'); if(!Number.isInteger(pages)||pages<1||pages>max||(type==='cover'&&pages!==1)) failures.push(type==='resume'?'resume page count':'cover must be exactly one page'); return {ok:!failures.length, failures};
}
export function atomicWrite(file, content) { const temp=file+'.tmp-'+process.pid; fs.writeFileSync(temp,content,{encoding:'utf8',flag:'wx'}); try { fs.renameSync(temp,file); } catch(e) { fs.rmSync(temp,{force:true}); throw e; } }
export function loadTemplates(root=path.resolve('templates')) { return {resume:fs.readFileSync(path.join(root,'resume.ats.html'),'utf8'),cover:fs.readFileSync(path.join(root,'cover-letter.html'),'utf8')}; }
export function chromiumPath(){for(const p of ['chromium','chromium-browser','google-chrome'])try{execFileSync(p,['--version'],{stdio:'ignore'});return p}catch{}return null;}
export function renderPdf(html,{browser=chromiumPath(),pdfinfo='pdfinfo',pdftotext='pdftotext',outputDir=os.tmpdir()}={}){if(!browser)return {ok:false,available:false,error:'Chromium unavailable'};const d=fs.mkdtempSync(path.join(outputDir,'materials-')),h=path.join(d,'input.html'),p=path.join(d,'output.pdf');try{fs.writeFileSync(h,html);execFileSync(browser,['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-default-apps','--disable-extensions','--host-resolver-rules=MAP * ~NOTFOUND','--print-to-pdf='+p,'file://'+h],{stdio:'pipe'});const info=execFileSync(pdfinfo,[p],{encoding:'utf8'}),text=execFileSync(pdftotext,[p,'-'],{encoding:'utf8'}),pages=Number(info.match(/^Pages:\s*(\d+)/m)?.[1]);return {ok:true,available:true,pdf:p,pages,text,networkRequests:0};}catch(e){return {ok:false,available:true,error:e.message};}}
