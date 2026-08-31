const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const ALLOWED_PRIVATE_KEYS = new Set(['assets/resume_profile.yaml','assets/master_resume_ev.md','assets/master_resume_ai.md','assets/profile-manifest.json']);
export const PROFILE_MANIFEST_KEY = 'assets/profile-manifest.json';
export const MAX_INPUT = MAX_INPUT_BYTES;
export async function sha256Hex(value){const bytes=new TextEncoder().encode(String(value));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('')}
export function normalizeProfile(value){return String(value??'').replace(/\r\n?/g,'\n').replace(/[ \t]+$/gm,'').trim()+'\n'}
export async function profileRevision(value){return sha256Hex(normalizeProfile(value))}
export function validatePrivateKey(key){return ALLOWED_PRIVATE_KEYS.has(key)}
export function validateInput({bytes,type}){if(!Number.isInteger(bytes)||bytes<0||bytes>MAX_INPUT_BYTES)throw new Error('profile input exceeds 2 MiB limit');if(!['pdf','text','linkedin'].includes(type))throw new Error('unsupported profile input type; OCR/DOCX are deferred');return true}
export function validateProfile(profile){const text=normalizeProfile(profile);if(text.length<2||text.length>MAX_INPUT_BYTES)throw new Error('profile content is empty or too large');return text}
export function extractLinkedInExport(text){const fields={};for(const line of String(text??'').replace(/\r\n?/g,'\n').split('\n')){const m=line.match(/^\s*([^:,]{1,80})\s*[:,]\s*(.{1,500})\s*$/);if(m)fields[m[1].trim().toLowerCase().replace(/\s+/g,'_')]=m[2].trim()}return Object.keys(fields).length?fields:{text:String(text??'').trim()}}
export function redactedLog(meta){return{status:String(meta?.status||'unknown'),type:String(meta?.type||'unknown'),bytes:Number(meta?.bytes)||0,revision:meta?.revision}}
export async function createProfileManifest(profile){const text=validateProfile(typeof profile==='string'?profile:JSON.stringify(profile));const revision=await profileRevision(text);return{schema:'profile-v1',revision,content_sha256:revision,bytes:new TextEncoder().encode(text).length}}
export function validateProfileManifest(m){return Boolean(m&&m.schema==='profile-v1'&&/^[a-f0-9]{64}$/.test(m.revision||'')&&m.revision===m.content_sha256)}
export async function writeIfNew(bucket,key,body,{confirm=false}={}){if(!validatePrivateKey(key))throw new Error('private key is not allowed');const revision=await sha256Hex(body);if(!confirm)return{status:'dry-run',key,revision};if(await bucket.head(key))return{status:'unchanged',key,revision};await bucket.put(key,body);return{status:'written',key,revision}}
