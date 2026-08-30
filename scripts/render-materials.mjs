#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import {loadTemplates,renderMaterials,hardGates} from './materials-renderer.mjs';
const args=process.argv.slice(2), i=args.indexOf('--fixture'), fixture=i>=0?args[i+1]:null, dry=args.includes('--dry-run');
if(!fixture) { console.error('Usage: node scripts/render-materials.mjs --fixture FILE [--dry-run]'); process.exitCode=2; } else { const data=JSON.parse(fs.readFileSync(fixture,'utf8')); const out=renderMaterials(data,loadTemplates()); if(dry) { console.log(JSON.stringify({revision:out.revision,resume:hardGates({type:'resume',text:out.resume.replace(/<[^>]+>/g,' '),pages:1}),cover:hardGates({type:'cover',text:out.cover.replace(/<[^>]+>/g,' '),pages:1}),networkRequests:0})); } }
