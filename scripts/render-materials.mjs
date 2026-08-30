#!/usr/bin/env node
import fs from 'node:fs';
import {loadTemplates,renderMaterials,renderPdf} from './materials-renderer.mjs';
const args=process.argv.slice(2); const dry=args.includes('--dry-run'); const i=args.indexOf('--fixture');
if(i<0||!args[i+1]||args.some((x,n)=>!['--fixture','--dry-run'].includes(x)&&n!==i+1)){console.error('usage: --fixture FILE [--dry-run]');process.exitCode=2;} else try {const out=renderMaterials(JSON.parse(fs.readFileSync(args[i+1],'utf8')),loadTemplates()); if(dry){console.log(JSON.stringify({revision:out.revision,dry_run:true,available:false,outputs_written:false,network_requests:null,network_policy:'blocked-by-static-input-and-browser-flags'}));} else {const resume=renderPdf(out.resume,{type:'resume'}),cover=renderPdf(out.cover,{type:'cover'});const result={revision:out.revision,resume,cover};console.log(JSON.stringify(result));process.exitCode=!(resume.ok&&cover.ok);}} catch(e){console.error(e.message);process.exitCode=1}
