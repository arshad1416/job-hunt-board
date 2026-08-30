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
  return {resume:r, cover:c, revision:crypto.createHash('sha256').update('materials-renderer-v2\0resume-template-v1\0cover-template-v1\0'+r+'\0'+c).digest('hex')};
}
export function hardGates({type, text='', pages, tofu=false, overflow=false, clipped=false, orphanHeading=false, networkRequests=0}={}) {
  const normalized=String(text).replace(/\s+/g,' ').trim(), failures=[]; if(!normalized) failures.push('missing extracted text'); if(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) failures.push('tofu/control marker'); if(/\b(overflow|clipped|cut off|layout error)\b/i.test(text)) failures.push('overflow/clipped marker'); const lines=String(text).split(/\r?\n/).map(x=>x.trim()).filter(Boolean); if(lines.length&&/^#{1,3}\s+|^[A-Z][A-Z &-]{3,}$/.test(lines.at(-1))&&!/[.!?:]$/.test(lines.at(-1))) failures.push('orphan heading'); if(tofu) failures.push('tofu'); if(overflow) failures.push('overflow'); if(clipped) failures.push('clipped content'); if(orphanHeading) failures.push('orphan heading'); if(networkRequests) failures.push('network requests'); if(!Number.isInteger(pages)||pages<1||(type==='resume'?pages>2:pages!==1)) failures.push('invalid page count'); return {ok:!failures.length,failures,normalizedText:normalized};
}
export function atomicWrite(file, content) { const temp=file+'.tmp-'+process.pid; fs.writeFileSync(temp,content,{encoding:'utf8',flag:'wx'}); try { fs.renameSync(temp,file); } catch(e) { fs.rmSync(temp,{force:true}); throw e; } }
export function loadTemplates(root=path.resolve('templates')) { return {resume:fs.readFileSync(path.join(root,'resume.ats.html'),'utf8'),cover:fs.readFileSync(path.join(root,'cover-letter.html'),'utf8')}; }
export function chromiumPath(){const bins=[process.env.CHROMIUM_BIN,'chromium','chromium-browser','google-chrome'].filter(Boolean);for(const p of bins)try{execFileSync(p,['--version'],{stdio:'ignore'});return p}catch{}return null;}
export function renderPdf(html,{type='resume',browser=chromiumPath(),pdfinfo='pdfinfo',pdftotext='pdftotext',outputDir=os.tmpdir(),destination=null,runner=execFileSync}={}){if(!browser)return {ok:false,available:false,error:'Chromium unavailable'};const d=fs.mkdtempSync(path.join(outputDir,'materials-')),h=path.join(d,'input.html'),p=path.join(d,'output.pdf');try{fs.writeFileSync(h,html);runner(browser,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-extensions','--disable-background-networking','--disable-default-apps','--disable-sync','--no-first-run','--no-pdf-header-footer','--virtual-time-budget=1000','--host-resolver-rules=MAP * ~NOTFOUND','--print-to-pdf='+p,'file://'+h],{stdio:'pipe'});const info=runner(pdfinfo,[p],{encoding:'utf8'}),text=runner(pdftotext,[p,'-'],{encoding:'utf8'}),pages=Number(info.match(/^Pages:\s*(\d+)/m)?.[1]),gates=hardGates({type,text,pages,networkRequests:0});if(!gates.ok)return {ok:false,available:true,gates,error:'PDF hard gates failed'};if(destination)atomicWrite(destination,fs.readFileSync(p));return {ok:true,available:true,pdf:destination||p,pages,text,networkRequests:0,gates};}catch(e){return {ok:false,available:true,error:e.message};}}
