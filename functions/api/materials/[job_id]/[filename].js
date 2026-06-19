/* ═══════════════════════════════════════════════════════════════
   GET /api/materials/:job_id/:filename
   Public (GET only — no auth, so browser can open in new tabs)

   Serves files from R2 bucket JOB_MATERIALS_BUCKET.
   Path params: job_id (int), filename (allow-listed)
   ═══════════════════════════════════════════════════════════════ */

// Allowed filenames (prevents R2 enumeration)
const ALLOWED_FILES = {
  'resume.md':       'text/markdown; charset=utf-8',
  'cover_letter.md': 'text/markdown; charset=utf-8',
  'job_details.json':'application/json; charset=utf-8'
};

export async function onRequestGet(context) {
  const { params, env } = context;

  const jobId = params.job_id;
  const filename = params.filename;

  // ── Validate filename against allow-list ──
  if (!ALLOWED_FILES.hasOwnProperty(filename)) {
    return new Response(
      JSON.stringify({ error: 'Forbidden: file type not allowed' }),
      {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  // ── Validate job_id is numeric ──
  if (!/^\d+$/.test(jobId)) {
    return new Response(
      JSON.stringify({ error: 'Invalid job_id' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  // ── Check R2 binding exists ──
  if (!env.JOB_MATERIALS_BUCKET) {
    return new Response(
      JSON.stringify({ error: 'R2 bucket not configured' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  // ── Fetch from R2 ──
  const key = `materials/${jobId}/${filename}`;
  const object = await env.JOB_MATERIALS_BUCKET.get(key);

  if (!object) {
    return new Response(
      JSON.stringify({ error: 'Not found: materials have not been generated for this job yet' }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  // ── Stream the file with correct content-type ──
  const contentType = ALLOWED_FILES[filename];
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Content-Disposition', `inline; filename="${filename}"`);
  headers.set('Cache-Control', 'private, max-age=300');

  return new Response(object.body, {
    status: 200,
    headers
  });
}
