#!/usr/bin/env node
import { tursoQuery, tursoExecute } from './lib/turso.mjs';
export const REQUIRED_COLUMNS={material_versions:{},render_jobs:{retry_at:'TEXT',source_artifact_prefix:'TEXT',resume_pdf_sha256:'TEXT',cover_letter_pdf_sha256:'TEXT',resume_pdf_bytes:'INTEGER',cover_letter_pdf_bytes:'INTEGER'}};
export async function applyMaterialSchemaUpgrade(env,{commit=false,query=tursoQuery,execute=tursoExecute}={}){const added=[];for(const [table,defs] of Object.entries(REQUIRED_COLUMNS)){const rows=await query(env,`PRAGMA table_info(${table})`);const have=new Set(rows.map(r=>r.name));for(const [name,type] of Object.entries(defs))if(!have.has(name)){added.push({table,name,type});if(commit)await execute(env,`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);}}return {commit,added};}
export const upgrade = applyMaterialSchemaUpgrade;
if(import.meta.url===`file://${process.argv[1]}`) console.log(JSON.stringify(await applyMaterialSchemaUpgrade({}, {commit:process.argv.includes('--commit')})));
