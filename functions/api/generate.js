/* ═══════════════════════════════════════════════════════════════
   POST /api/generate
   Auth: X-Auth-Token required (enforced by _middleware.js)

   Flow:
   1. Parse body { job_id, title?, company? }
   2. Fetch full job row from Turso (parameterized)
   3. Call GLM-5.2 (OpenCode Go) → resume.md + cover_letter.md
   4. Store in R2:  materials/<job_id>/{resume,cover_letter}.md
   5. Update Turso: status='materials_ready'
   6. Return material URLs
   ═══════════════════════════════════════════════════════════════ */

import { tursoQuery, tursoExecute } from '../_lib/turso.js';
import { signedMaterialUrls } from '../_lib/signing.js';

const GLM_ENDPOINT = 'https://opencode.ai/zen/go/v1/chat/completions';
const GLM_MODEL = 'glm-5.2';

// ── Candidate profile (embedded — same as Pi-side resume_profile.yaml) ──
const CANDIDATE_PROFILE = `
Name: Arshad Kazi
Location: Toronto, Ontario, Canada
Target roles: EV Commercial (Regional Sales Manager, Head of Sales, Commercial Director)
              AI/Engineering (AI Engineer, ML Engineer, Full Stack Engineer)

EV Commercial highlights:
- 8+ years in automotive / EV sales leadership and dealer network development
- Launched EV OEM dealer networks across Ontario and Eastern Canada
- Proven track record scaling revenue from $0 to $20M+ in emerging EV markets
- Deep relationships with BYD, Geely, Zeekr, and other Chinese EV OEMs entering Canada

AI/Engineering highlights:
- Full-stack development (Python, TypeScript, React, Node.js, Cloudflare Workers)
- Machine learning and LLM integration (OpenAI, fine-tuning, RAG pipelines)
- Built production AI systems serving 10K+ users
- Cloud architecture (AWS, Cloudflare, Turso/libSQL)

Strengths: cross-functional leadership, go-to-market strategy, technical depth,
bilingual (English/Hindi/Urdu), willing to relocate or travel extensively.
`;

// ── Prompt templates ──
function resumePrompt(job) {
  return `You are an expert resume writer. Create a tailored, professional resume in Markdown format
for the following job posting. Use the candidate profile below and tailor the experience,
skills, and summary to match the job requirements exactly.

CANDIDATE PROFILE:
${CANDIDATE_PROFILE}

JOB DETAILS:
- Title: ${job.title || 'N/A'}
- Company: ${job.company || 'N/A'}
- Location: ${job.location || 'N/A'}
- Salary: ${job.salary || 'Not specified'}
- Track: ${job.track || 'general'}
- Notes: ${job.notes || 'N/A'}

INSTRUCTIONS:
1. Write the resume in clean Markdown (## for sections, ** for emphasis)
2. Start with a compelling professional summary (3-4 lines) tailored to THIS role
3. Include relevant experience bullet points that map to the job requirements
4. List key skills aligned with the position
5. Keep it to one page (concise, impactful bullets)
6. Do NOT include contact details beyond name and location
7. Output ONLY the resume markdown — no preamble, no explanations

Begin:`;
}

function coverLetterPrompt(job) {
  return `You are an expert cover letter writer. Create a compelling, tailored cover letter
in Markdown format for the following job posting.

CANDIDATE PROFILE:
${CANDIDATE_PROFILE}

JOB DETAILS:
- Title: ${job.title || 'N/A'}
- Company: ${job.company || 'N/A'}
- Location: ${job.location || 'N/A'}
- Salary: ${job.salary || 'Not specified'}
- Track: ${job.track || 'general'}
- Notes: ${job.notes || 'N/A'}

INSTRUCTIONS:
1. Write in a professional but warm tone
2. Address it to the hiring manager (use "Dear Hiring Manager" if no name)
3. Open with a strong hook referencing the specific role and company
4. Highlight 2-3 key achievements most relevant to THIS job
5. Show genuine enthusiasm and cultural fit
6. Close with a clear call to action
7. Keep it to 3-4 paragraphs (under 350 words)
8. Output ONLY the cover letter — no preamble, no explanations

Begin:`;
}

/**
 * Call GLM-5.2 via the OpenCode Go chat completions API.
 * @returns {Promise<string>} the generated text content
 */
async function callGLM(apiKey, prompt) {
  const res = await fetch(GLM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GLM_MODEL,
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 2000
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('GLM API HTTP ' + res.status + ': ' + text.slice(0, 300));
  }

  const data = await res.json();
  // OpenAI-compatible response format
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('GLM API returned empty content');
  }
  return content;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // ── 1. Parse body ──
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const jobId = body.job_id;
  if (!jobId) {
    return json({ error: 'Missing required field: job_id' }, 400);
  }

  // ── 2. Fetch full job from Turso ──
  let job;
  try {
    const rows = await tursoQuery(
      env,
      'SELECT * FROM applications WHERE id = ?',
      [jobId]
    );
    job = rows[0];
  } catch (err) {
    console.error('Turso fetch error:', err);
    return json({ error: 'Database error: could not fetch job' }, 500);
  }

  if (!job) {
    return json({ error: 'Job not found: ' + jobId }, 404);
  }

  // ── 3. Check if materials already exist (idempotent shortcut) ──
  if (env.JOB_MATERIALS_BUCKET) {
    try {
      const existing = await env.JOB_MATERIALS_BUCKET.head(
        `materials/${jobId}/resume.md`
      );
      if (existing) {
        // Materials already generated — return URLs without regenerating.
        // Don't downgrade an existing 'applied' status (C3).
        await tursoExecute(
          env,
          "UPDATE applications SET status='materials_ready', updated_at=datetime('now') WHERE id=? AND status!='applied'",
          [jobId]
        );
        return json({
          success: true,
          job_id: jobId,
          cached: true,
          materials: await signedMaterialUrls(env, jobId)
        });
      }
    } catch {
      // R2 check failed — proceed to generate
    }
  }

  // ── 4. Call GLM-5.2 for resume + cover letter ──
  let resumeMd, coverMd;
  try {
    [resumeMd, coverMd] = await Promise.all([
      callGLM(env.OPENCODE_GO_API_KEY, resumePrompt(job)),
      callGLM(env.OPENCODE_GO_API_KEY, coverLetterPrompt(job))
    ]);
  } catch (err) {
    console.error('GLM generation error:', err);
    return json({ error: 'AI generation failed: ' + err.message }, 502);
  }

  // ── 5. Store in R2 ──
  if (env.JOB_MATERIALS_BUCKET) {
    const key = `materials/${jobId}`;
    const jobDetails = JSON.stringify({
      job_id: jobId,
      title: job.title,
      company: job.company,
      location: job.location,
      salary: job.salary,
      track: job.track,
      generated_at: new Date().toISOString()
    }, null, 2);

    try {
      await Promise.all([
        env.JOB_MATERIALS_BUCKET.put(`${key}/resume.md`, resumeMd, {
          httpMetadata: { contentType: 'text/markdown; charset=utf-8' }
        }),
        env.JOB_MATERIALS_BUCKET.put(`${key}/cover_letter.md`, coverMd, {
          httpMetadata: { contentType: 'text/markdown; charset=utf-8' }
        }),
        env.JOB_MATERIALS_BUCKET.put(`${key}/job_details.json`, jobDetails, {
          httpMetadata: { contentType: 'application/json' }
        })
      ]);
    } catch (err) {
      console.error('R2 store error:', err);
      return json({ error: 'Storage error: could not save materials' }, 500);
    }
  }

  // ── 6. Update Turso status ──
  // Only advance to 'materials_ready' if not already 'applied' (C3 — no downgrade).
  try {
    await tursoExecute(
      env,
      "UPDATE applications SET status='materials_ready', updated_at=datetime('now') WHERE id=? AND status!='applied'",
      [jobId]
    );
  } catch (err) {
    console.error('Turso update error:', err);
    // Non-fatal — materials are in R2, just status not updated
  }

  // ── 7. Return success (short-lived signed links) ──
  return json({
    success: true,
    job_id: jobId,
    materials: await signedMaterialUrls(env, jobId)
  });
}

/** Helper: JSON response */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
