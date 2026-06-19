/**
 * POST /api/generate
 * Generates tailored resume + cover letter via GLM-5.2 (OpenCode Go),
 * stores in R2, returns download URLs.
 */
export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = cors();

  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const { job_id, title, company } = await request.json();
    if (!job_id || !title || !company) {
      return new Response(JSON.stringify({ error: 'Missing required fields: job_id, title, company' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Fetch job details from Turso
    const job = await fetchJobFromTurso(job_id, env);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found in database' }), {
        status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Generate resume via GLM-5.2
    const resumeMd = await callGLM(generateResumePrompt(job), env);
    // Generate cover letter via GLM-5.2
    const coverMd = await callGLM(generateCoverLetterPrompt(job), env);

    // Store in R2
    const key = `materials/${job_id}`;
    const r2 = env.JOB_MATERIALS_BUCKET;
    if (r2) {
      await r2.put(`${key}/resume.md`, resumeMd, {
        httpMetadata: { contentType: 'text/markdown' },
      });
      await r2.put(`${key}/cover_letter.md`, coverMd, {
        httpMetadata: { contentType: 'text/markdown' },
      });
      await r2.put(`${key}/job_details.json`, JSON.stringify(job, null, 2), {
        httpMetadata: { contentType: 'application/json' },
      });
    }

    // Update Turso status
    await updateTursoStatus(job_id, 'materials_ready', env);

    return new Response(JSON.stringify({
      success: true,
      job_id,
      materials: {
        resume: `/api/materials/${job_id}/resume.md`,
        cover_letter: `/api/materials/${job_id}/cover_letter.md`,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

  } catch (err) {
    console.error('Generate error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function fetchJobFromTurso(jobId, env) {
  const url = env.TURSO_URL || 'https://morning-briefing-arshad1416.aws-us-east-1.turso.io';
  const token = env.TURSO_TOKEN;
  if (!token) throw new Error('TURSO_TOKEN not configured');

  const sql = `SELECT * FROM applications WHERE id = ${parseInt(jobId) || 0}`;
  const body = JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }] });

  const res = await fetch(`${url}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) throw new Error(`Turso fetch failed: ${res.status}`);
  const data = await res.json();

  try {
    const result = data.results[0].response.result;
    const cols = result.cols.map(c => c.name);
    const row = result.rows[0];
    if (!row) return null;
    const job = {};
    row.forEach((cell, i) => { job[cols[i]] = cell.value; });
    return job;
  } catch {
    return null;
  }
}

async function updateTursoStatus(jobId, status, env) {
  const url = env.TURSO_URL || 'https://morning-briefing-arshad1416.aws-us-east-1.turso.io';
  const token = env.TURSO_TOKEN;
  if (!token) return;

  const sql = `UPDATE applications SET status = '${status.replace(/'/g, "''")}', updated_at = datetime('now') WHERE id = ${parseInt(jobId) || 0}`;
  const body = JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }] });

  await fetch(`${url}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });
}

async function callGLM(prompt, env) {
  const apiKey = env.OPENCODE_GO_API_KEY;
  if (!apiKey) throw new Error('OPENCODE_GO_API_KEY not configured');

  const payload = {
    model: 'glm-5.2',
    messages: [
      { role: 'system', content: 'You are an expert career coach and resume writer. Output ONLY the requested document — no explanations, no commentary.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 8192,
  };

  const res = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GLM API error: ${res.status} ${err.substring(0, 300)}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

function generateResumePrompt(job) {
  return `Generate an ATS-optimized resume tailored to this job posting.

CANDIDATE PROFILE:
- Current: Regional Sales Manager at CARFii (automotive finance brokerage), managing 62 dealer partners
- Past: Tesla Regional Delivery Operations Manager Canada (2014-2017) — owned National Product Launch, MTO/MOF liaison
- Past: SHIFT Motors Business Manager (2017-2018) — launched Canada's first third-party Tesla warranty
- Past: Veterans Affairs Canada National Learning Officer (2022-2024) — e-learning platform deployment
- Personal projects: ShiftLogic.ai (automotive scraping), Hermes Agent (multi-model AI agent system)
- OMVIC Certified since 2017
- Education: Studies at TMU (Business Technology Management) and Athabasca University

TARGET JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location || 'Not specified'}

RULES:
1. 1-2 pages max, ATS-friendly formatting
2. Prioritize experience most relevant to the target role
3. Use strong action verbs, quantify results where possible
4. Never fabricate experience
5. Label Hermes Agent as a personal project, NOT employment
6. Use "Studies" wording for incomplete degrees
7. Output as clean markdown only`;
}

function generateCoverLetterPrompt(job) {
  return `Write a concise, compelling cover letter for this application.

CANDIDATE: Arshad Kazi — EV Commercial Leader & AI Systems Builder
CURRENT ROLE: Regional Sales Manager, CARFii (62 dealer partners, automotive finance)
KEY STRENGTHS: Tesla's Canadian NPI launch (primary MTO/MOF liaison, 100%+ YoY growth),
Canada's first third-party Tesla warranty, AI agent system (Hermes Agent), OMVIC certified

TARGET JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location || 'Not specified'}

FORMAT: 3 paragraphs max (Problem / Evidence / Close)
1. OPENING: Lead with a business problem the company faces, position Arshad as the solver
2. EVIDENCE: 2-3 specific achievements that directly address the company's needs
3. CLOSE: Specific, confident call to action

RULES:
- Max 300 words
- Never fabricate claims
- Be direct, no generic fluff
- Output plain text only`;
}
