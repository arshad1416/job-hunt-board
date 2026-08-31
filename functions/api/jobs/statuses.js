import { tursoQuery } from '../../_lib/turso.js';
import { normalizeStatus } from '../../_lib/status.js';

const MAX_IDS = 100;
const MAX_RESPONSE = 64 * 1024;
// Snapshot-only knockout warnings are intentionally not queried from Turso.
const FIELDS = ['id','status','updated_at','applied_at','follow_up_due','urgency','is_repost','gate'];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin' } });

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const raw = q.get('ids') || q.get('job_ids');
  if (!raw) return json({ error: 'ids is required' }, 400);
  const parts = raw.split(',').map(x => x.trim());
  const ids = [...new Set(parts.filter(x => /^\d+$/.test(x)).map(Number))];
  if (!ids.length || parts.length > MAX_IDS || parts.some(x => !/^\d+$/.test(x)) || ids.some(x => x > 2147483647) || raw.length > 2000) return json({ error: 'ids must contain 1-100 numeric IDs' }, 400);
  const status = q.get('status');
  if (status && !normalizeStatus(status)) return json({ error: 'invalid status' }, 400);
  const placeholders = ids.map(() => '?').join(',');
  try {
    let rows = await tursoQuery(env, 'SELECT id,status,updated_at,applied_at,follow_up_due,urgency,is_repost,gate FROM applications WHERE id IN (' + placeholders + ') ORDER BY id', ids);
    if (status) rows = rows.filter(r => normalizeStatus(r.status) === normalizeStatus(status));
    const response = { statuses: rows.map(row => Object.fromEntries(FIELDS.map(k => [k, row[k] ?? null]))) };
    if (JSON.stringify(response).length > MAX_RESPONSE) return json({ error: 'response too large' }, 413);
    return json(response);
  } catch (error) { console.error('job status read failed:', error); return json({ error: 'Database error: could not read job statuses' }, 500); }
}
