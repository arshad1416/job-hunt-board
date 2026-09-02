import assert from 'node:assert/strict';
import test, { after } from 'node:test';

const { onRequestPost } = await import('../functions/api/generate.js');
const { sha256Hex, profileRevision } = await import('../functions/_lib/profile-manifest.js');

const profile = 'Name: Ada Lovelace\nSummary: Software engineer with 5 years experience building JavaScript applications and APIs.\nSkills: JavaScript, TypeScript, React, Node.js, SQL, testing, accessibility.\n';
const reference = '# Ada Lovelace\n\n## Experience\n- Built JavaScript applications and APIs with TypeScript, React, Node.js, and SQL.\n- Improved reliability through testing and accessibility practices.\n';
const resume = 'Ada Lovelace\nada@example.com | 555-555-5555\n\n## Summary\nSoftware engineer with 5 years experience building JavaScript applications and APIs.\n\n## Skills\nJavaScript, TypeScript, React, Node.js, SQL, testing, accessibility.\n\n## Experience\n2020/01 - 2024/01\n- Built JavaScript applications and APIs with TypeScript, React, Node.js, and SQL.\n- Improved reliability through testing and accessibility practices.\n\n## Education\nBachelor of Computer Science\n';
const cover = "Dear Hiring Team,\n\nI am excited to apply my JavaScript and TypeScript experience building applications and APIs. Your role's focus on React, Node.js, SQL, testing, and accessibility matches my background.\n\nSincerely,\nAda Lovelace\n";
const store = new Map();
const bucket = { store, put: async (k, b) => store.set(k, typeof b === 'string' ? b : String(b)), head: async k => store.has(k) ? {} : null, get: async k => store.has(k) ? { text: async () => store.get(k) } : null };
const env = { TURSO_URL: 'https://turso.test', TURSO_TOKEN: 'token', NINEROUTER_API_KEY: 'llm', MATERIALS_SIGNING_KEY: 'signing', DASHBOARD_AUTH_TOKEN: 'fallback', JOB_MATERIALS_BUCKET: bucket };
const revision = await profileRevision(profile);
const profileKey = 'assets/profile/revisions/' + revision + '/profile.json';
store.set('assets/profile/current.json', JSON.stringify({ schema: 'profile-v2', revision, content_sha256: revision, bytes: new TextEncoder().encode(profile).length, source_type: 'text', object_hashes: { profile: revision, 'assets/master_resume_ev.md': await sha256Hex(reference) }, profile_key: profileKey, reference_keys: ['assets/master_resume_ev.md'], reference_key: 'assets/master_resume_ev.md' }));
store.set(profileKey, profile); store.set('assets/master_resume_ev.md', reference);
const originalFetch = globalThis.fetch;
const calls = [];
const state = { artifactPrefix: null, currentVersion: null, currentInserted: false };
globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith(env.TURSO_URL)) {
    const body = JSON.parse(options.body); const sql = body.requests[0].stmt.sql; calls.push(sql);
    let rows = []; let cols = [];
    const args = body.requests[0].stmt.args || [];
    // Anchor to the UPDATE only: the getCurrentMaterial SELECT also contains state='succeeded'.
    if (/^UPDATE material_versions SET state='succeeded'/i.test(sql)) { state.artifactPrefix = args[0]?.value; state.currentVersion = args[2]?.value; }
    if (/INSERT INTO material_current/i.test(sql)) { state.currentVersion = args[1]?.value; state.currentInserted = true; }
    if (/SELECT mv\.\* FROM material_current/i.test(sql) && state.currentInserted && state.currentVersion) { cols = ['id', 'version', 'artifact_prefix']; rows = [[{type:'integer',value:'1'},{type:'text',value:state.currentVersion},{type:'text',value:state.artifactPrefix}]]; } else if (/SELECT \* FROM applications/i.test(sql)) { cols = ['id','title','company','description','track','location','salary','url']; rows = [[{type:'integer',value:'123'},{type:'text',value:'Software Engineer'},{type:'text',value:'Acme'},{type:'text',value:'Build JavaScript and TypeScript applications and APIs with React, Node.js, SQL, testing, and accessibility.'},{type:'text',value:'engineering'},{type:'text',value:'Remote'},{type:'text',value:'100000'},{type:'null'}]]; } else if (!/material_current/i.test(sql) && /SELECT .*material_versions/i.test(sql)) { cols = ['id']; rows = [[{type:'integer',value:'1'}]]; }
    const write = /INSERT INTO material_versions|UPDATE material_versions|INSERT INTO render_jobs|INSERT INTO material_current|UPDATE material_current/i.test(sql);
    return Response.json({ results: [{ type: 'ok', response: { result: { cols: write ? [] : cols.map(name => ({name})), rows, affected_row_count: write ? 1 : 0 } } }] });
  }
  const body = JSON.parse(options.body); const prompt = body.messages?.[0]?.content || '';
  const content = /ruthless senior resume reviewer/i.test(prompt)
    ? '<<<RESUME\n' + resume + '\n>>>\n<<<COVER_LETTER\n' + cover + '\n>>>\n<<<ASSESSMENT\nKept sourced skills.\n>>>'
    : (/cover letter/i.test(prompt) ? cover : resume);
  return Response.json({ choices: [{ message: { content } }] });
};
after(() => { globalThis.fetch = originalFetch; });

test('generate handler stages and succeeds end-to-end', async () => {
  const res = await onRequestPost({ env, request: new Request('https://x/api/generate', { method: 'POST', body: JSON.stringify({ job_id: '123' }) }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.cached, false);
  const staged = [...store.keys()].filter(k => k.includes('/versions/') && k.includes('/attempt-'));
  assert.equal(staged.length, 4);
  assert.deepEqual(new Set(staged.map(k => k.split('/').pop())), new Set(['resume.md', 'cover_letter.md', 'job_details.json', 'manifest.json']));
  assert.ok(calls.some(sql => /UPDATE material_versions/i.test(sql)));
  assert.ok(calls.some(sql => /UPDATE material_versions/i.test(sql) && /succeeded/i.test(sql)));
  assert.equal(body.quality.reviewer_used, true);
});
