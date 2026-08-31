#!/usr/bin/env node
import fs from 'node:fs';
import { extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateInput, validateProfile, extractLinkedInExport, createProfileManifest, redactedLog, writeIfNew, PROFILE_MANIFEST_POINTER, profileKey } from '../functions/_lib/profile-manifest.js';
const defaultRun=promisify(execFile);
export async function intakeProfile(input,{confirm=false,bucket,readFile=fs.promises.readFile,run=defaultRun,keys={}}={}) {
 const type=input?.type||extname(String(input?.path||input)).slice(1).toLowerCase(); const path=input?.path||input;
 if(['docx','doc'].includes(type)) throw new Error('DOCX intake is deferred; OCR is not supported');
 const original=await readFile(path); if(original.byteLength>2*1024*1024) throw new Error('profile input exceeds 2 MiB limit'); const extracted= type==='pdf' ? await run('pdftotext',['-layout',path,'-'],{}) : {stdout:original.toString('utf8'),code:0}; if(type==='pdf' && (extracted.code !== undefined && extracted.code !== 0 || typeof extracted.stdout!=='string')) throw new Error('PDF text extraction failed'); const textRaw=String(extracted.stdout);
 if (type==='pdf' && !textRaw.trim()) throw new Error('PDF produced no text; OCR is deferred');
 validateInput({bytes:Buffer.byteLength(textRaw),type:type==='linkedin'?'linkedin':type==='pdf'?'pdf':'text'});
 const linked=type==='linkedin'||type==='json'||input?.linkedin===true; const content=validateProfile(linked?JSON.stringify(extractLinkedInExport(textRaw)):textRaw);
 const lib=await import('../functions/_lib/profile-manifest.js'); const revision=await lib.profileRevision(content); const selectedReferenceKey=keys.reference_key; const reference_keys=keys.reference_keys||[]; if(confirm && !selectedReferenceKey) throw new Error('selected reference key is required'); if(selectedReferenceKey) lib.referenceKey(selectedReferenceKey); if(confirm && !reference_keys.includes(selectedReferenceKey)) throw new Error('selected reference key must be declared'); const objectHashes={profile:await lib.sha256Hex(content)}; if(confirm && !bucket) throw new Error('private profile bucket is required'); if(confirm) { for(const key of reference_keys) { const obj=await bucket.get(key); if(!obj || typeof obj.text!=='function') throw new Error('reference object is missing or unreadable'); const text=await obj.text(); if(typeof text!=='string' || Buffer.byteLength(text)>2*1024*1024) throw new Error('reference object is invalid'); objectHashes[key]=await lib.sha256Hex(text); } } const manifest=await createProfileManifest(content,{sourceType:linked?'linkedin':type,objectHashes,profile_key:profileKey(revision),reference_keys,reference_key:selectedReferenceKey||null});
 if(confirm && !lib.validateProfileManifest(manifest)) throw new Error('profile manifest is invalid');
 if(!confirm)return redactedLog({status:'dry-run',type:manifest.source_type,bytes:manifest.bytes,revision:manifest.revision});
 if(!bucket)throw new Error('private profile bucket is required');
 const pkey=manifest.profile_key; const profile=await writeIfNew(bucket,pkey,content,{confirm:true});
 const pointer=JSON.stringify({...manifest,profile_key:pkey});
 // Revision objects are immutable; only the private selector is updated.
 await writeIfNew(bucket,keys.current_key||PROFILE_MANIFEST_POINTER,pointer,{confirm:true,onlyIfNew:false});
 return redactedLog({status:profile.status==='written'?'written':'unchanged',type:manifest.source_type,bytes:manifest.bytes,revision:manifest.revision});
}
export const previewProfile=(input,options={})=>intakeProfile(input,{...options,confirm:false});
if(import.meta.url===`file://${process.argv[1]}`){const path=process.argv.find(x=>!x.startsWith('--')&&x!==process.argv[1]);if(!path){console.error('usage: intake-profile.mjs FILE [--confirm] [--reference-key assets/master_resume_ev.md]');process.exit(2)}intakeProfile(path,{confirm:process.argv.includes('--confirm'),keys:{reference_key:process.argv[process.argv.indexOf('--reference-key')+1],reference_keys:process.argv.includes('--reference-key')?[process.argv[process.argv.indexOf('--reference-key')+1]]:[]}}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exit(1)})}