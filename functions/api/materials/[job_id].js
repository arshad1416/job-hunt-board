/**
 * GET /api/materials/:job_id/:filename
 * Serves generated resume/cover letter from R2.
 */
export async function onRequest(context) {
  const { request, env, params } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const { job_id, filename } = params;
  if (!job_id || !filename) {
    return new Response('Missing job_id or filename', { status: 400, headers: corsHeaders });
  }

  // Only allow specific filenames
  const allowed = ['resume.md', 'cover_letter.md', 'job_details.json'];
  if (!allowed.includes(filename)) {
    return new Response('File not allowed', { status: 403, headers: corsHeaders });
  }

  const r2 = env.JOB_MATERIALS_BUCKET;
  if (!r2) {
    return new Response('R2 bucket not configured', { status: 500, headers: corsHeaders });
  }

  try {
    const key = `materials/${job_id}/${filename}`;
    const obj = await r2.get(key);

    if (!obj) {
      return new Response('Materials not found. Generate them first.', {
        status: 404, headers: corsHeaders,
      });
    }

    const contentType = filename.endsWith('.md') ? 'text/markdown' : 'application/json';
    return new Response(obj.body, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=3600',
        ...corsHeaders,
      },
    });

  } catch (err) {
    console.error('Materials fetch error:', err);
    return new Response(err.message, { status: 500, headers: corsHeaders });
  }
}
