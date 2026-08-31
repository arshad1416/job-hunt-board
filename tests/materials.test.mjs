import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/materials/[job_id]/[filename].js';

test('material downloads are named attachments for sharing', async () => {
  const result = await onRequestGet({
    params: { job_id: '10180', filename: 'resume.md' },
    env: { JOB_MATERIALS_BUCKET: { get: async () => ({ body: 'resume' }) } }
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
  assert.equal(result.headers.get('Content-Disposition'), 'attachment; filename="resume.md"');
});

test('cover letter downloads are named attachments too', async () => {
  const result = await onRequestGet({
    params: { job_id: '10180', filename: 'cover_letter.md' },
    env: { JOB_MATERIALS_BUCKET: { get: async () => ({ body: 'letter' }) } }
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Content-Disposition'), 'attachment; filename="cover_letter.md"');
});

test('legacy PDF requests fail with private security headers', async () => { const r=await onRequestGet({params:{job_id:'12',filename:'resume.pdf'},env:{JOB_MATERIALS_BUCKET:{get:async()=>null}}}); assert.equal(r.status,404); assert.equal(r.headers.get('Cache-Control'),'private, no-store'); assert.equal(r.headers.get('X-Content-Type-Options'),'nosniff'); assert.equal(r.headers.get('X-Robots-Tag'),'noindex, nofollow'); });