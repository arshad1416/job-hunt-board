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
 const raw= type==='pdf' ? (await run('pdftotext',['-layout',path,'-'],{})).stdout : (await readFile(path)).toString('utf8');
 if (type==='pdf' && !raw.trim()) throw new Error('PDF produced no text; OCR is deferred');
 validateInput({bytes:Buffer.byteLength(raw),type:type==='linkedin'?'linkedin':type==='pdf'?'pdf':'text'});
 const linked=type==='linkedin'||type==='json'||input?.linkedin===true; const content=validateProfile(linked?JSON.stringify(extractLinkedInExport(raw)):raw);
 const lib=await import('../functions/_lib/profile-manifest.js'); const revision=await lib.profileRevision(content); const reference_keys=keys.reference_keys||[]; for(const key of reference_keys) lib.referenceKey(key); const objectHashes={profile:await lib.sha256Hex(content)}; if(bucket) for(const key of reference_keys){const obj=await bucket.get(key); if(obj) objectHashes[key]=await lib.sha256Hex(await obj.text())} const manifest=await createProfileManifest(content,{sourceType:linked?'linkedin':type,objectHashes,profile_key:profileKey(revision),reference_keys});
 if(!confirm)return redactedLog({status:'dry-run',type:manifest.source_type,bytes:manifest.bytes,revision:manifest.revision});
 if(!bucket)throw new Error('private profile bucket is required');
 const pkey=manifest.profile_key; const profile=await writeIfNew(bucket,pkey,content,{confirm:true});
 const pointer=JSON.stringify({...manifest,profile_key:pkey}); const current=await writeIfNew(bucket,keys.current_key||PROFILE_MANIFEST_POINTER,pointer,{confirm:true});
 return redactedLog({status:profile.status==='written'||current.status==='written'?'written':'unchanged',type:manifest.source_type,bytes:manifest.bytes,revision:manifest.revision});
}
export const previewProfile=(input,options={})=>intakeProfile(input,{...options,confirm:false});
if(import.meta.url===`file://${process.argv[1]}`){const path=process.argv.find(x=>!x.startsWith('--')&&x!==process.argv[1]);if(!path){console.error('usage: intake-profile.mjs FILE [--confirm]');process.exit(2)}intakeProfile(path,{confirm:process.argv.includes('--confirm')}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exit(1)})}
