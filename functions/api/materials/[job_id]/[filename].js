import { getCurrentMaterial, getMaterialVersion, getMaterialPdfState } from '../../../_lib/material-store.js';
import { validateManifestBytes } from '../../../_lib/material-state.js';

/* ═══════════════════════════════════════════════════════════════
   GET /api/materials/:job_id/:filename
   NOT public. _middleware.js requires either an X-Auth-Token header
   or a valid signed ?token= (see functions/_lib/signing.js), so
   enumerating numeric job_ids returns 401, not a resume.

   Serves files from R2 bucket JOB_MATERIALS_BUCKET.
   Markdown resume and cover-letter responses download as named attachments
   so they can be opened in Word/Google Docs or converted to PDF before sharing.
   Path params: job_id (int), filename (allow-listed)
   ═══════════════════════════════════════════════════════════════ */

// Allowed filenames (prevents R2 enumeration)
const ALLOWED_FILES = {
  'resume.md':       { type: 'text/markdown; charset=utf-8', disposition: 'attachment', download: 'resume.md' },
  'cover_letter.md': { type: 'text/markdown; charset=utf-8', disposition: 'attachment', download: 'cover_letter.md' },
  'job_details.json': { type: 'application/json; charset=utf-8', disposition: 'inline', download: 'job_details.json' },
  'manifest.json': { type: 'application/json; charset=utf-8', disposition: 'inline', download: 'manifest.json' },
  'resume.pdf': { type: 'application/pdf', disposition: 'attachment', download: 'resume.pdf' },
  'cover_letter.pdf': { type: 'application/pdf', disposition: 'attachment', download: 'cover_letter.pdf' }
};

export async function onRequestGet(context) {
  const { params, env } = context;

  const jobId = params.job_id;
  const filename = params.filename;

  // ── Validate filename against allow-list ──
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_FILES, filename)) {
    return routeError('Forbidden: file type not allowed', 403);
  }

  // ── Validate job_id is numeric ──
  if (!/^\d+$/.test(jobId)) return routeError('Invalid job_id', 400);

  // ── Check R2 binding exists ──
  if (!env.JOB_MATERIALS_BUCKET) return routeError('R2 bucket not configured', 503);

  // ── Fetch from R2 ──
  const version = params.version;
  if (version && !/^[a-f0-9]{64}$/i.test(version)) return routeError('Invalid material version', 400);
  let material = null;
  if (version) {
    const normalizedVersion = version.toLowerCase();
    material = await getMaterialVersion(env, jobId, normalizedVersion);
    const expected = new RegExp('^materials/' + String(jobId) + '/versions/' + normalizedVersion + '/attempt-[A-Za-z0-9_-]{1,80}$');
    if (!material || material.state !== 'succeeded' || !material.source_exists || !material.hard_gates_pass || typeof material.artifact_prefix !== 'string' || !expected.test(material.artifact_prefix)) return routeError('Unverified material version is unavailable', 404);
    if (filename.endsWith('.pdf')) { const pdf = await getMaterialPdfState(env, jobId, material, env.JOB_MATERIALS_BUCKET); if (!pdf.ready) return routeError(pdf.state === 'failed' ? 'PDF rendering failed' : 'PDF is not available', 404); }
  }
  if (!version && filename.endsWith('.pdf')) return routeError('PDF requires a verified material version', 404);
  const key = version ? material.artifact_prefix + '/' + filename : `materials/${jobId}/${filename}`;
  let object;
  try { object = await env.JOB_MATERIALS_BUCKET.get(key); } catch { return routeError('Material storage unavailable', 503); }
  if (version && object) {
    try {
      const read = async (item) => item.arrayBuffer ? item.arrayBuffer() : new TextEncoder().encode(await item.text()).buffer;
      const prefix = material.artifact_prefix;
      const [manifestSource, resumeSource, coverSource, detailsSource] = await Promise.all([
        env.JOB_MATERIALS_BUCKET.get(prefix + '/manifest.json'), env.JOB_MATERIALS_BUCKET.get(prefix + '/resume.md'), env.JOB_MATERIALS_BUCKET.get(prefix + '/cover_letter.md'), env.JOB_MATERIALS_BUCKET.get(prefix + '/job_details.json')
      ]);
      if (!manifestSource || !resumeSource || !coverSource || !detailsSource) throw new Error('incomplete source set');
      const manifest = JSON.parse(new TextDecoder().decode(await read(manifestSource)));
      const valid = await validateManifestBytes(manifest, { resume: await read(resumeSource), coverLetter: await read(coverSource), details: await read(detailsSource) }, { jobId, version });
      if (!valid) throw new Error('source integrity mismatch');
    } catch { return routeError('Material integrity verification failed', 404); }
  }

  if (!object) return routeError('Not found: materials have not been generated for this job yet', 404);

  // ── Stream the file with correct content-type ──
  const file = ALLOWED_FILES[filename];
  const headers = new Headers();
  headers.set('Content-Type', file.type);
  // Markdown is the source format; downloads are explicitly named so it can
  // be opened in Word/Google Docs or converted to PDF before sharing.
  headers.set('Content-Disposition', `${file.disposition}; filename="${file.download}"`);
  // Personal documents: never cached by shared caches, never indexed.
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Robots-Tag', 'noindex, nofollow');

  return new Response(object.body, {
    status: 200,
    headers
  });
}
function routeError(message, status) { return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' } }); }
function error(message, status) { return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' } }); }