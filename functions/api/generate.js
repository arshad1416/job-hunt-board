/* ═══════════════════════════════════════════════════════════════
   POST /api/generate
   Auth: X-Auth-Token required (enforced by _middleware.js)

   Flow:
   1. Parse body { job_id, title?, company? }
   2. Fetch full job row from Turso (parameterized) — including the
      `description` column, so the model sees the real JD body and not
      just the job title
   3. Call GLM-5.2 (OpenCode Go) → resume.md + cover_letter.md
   4. Store in R2:  materials/<job_id>/{resume,cover_letter}.md
   5. Update Turso: status='materials_ready'
   6. Return material URLs
   ═══════════════════════════════════════════════════════════════ */

import { tursoQuery, tursoExecute } from '../_lib/turso.js';
import { signedMaterialUrls } from '../_lib/signing.js';
import { extractJobDescription } from '../_lib/extract-jd.mjs';
import { fetchPublicAtsJob } from '../_lib/public-ats.mjs';
import { isSafePublicHttpUrl } from '../_lib/job-url.mjs';

const GLM_ENDPOINT = 'https://opencode.ai/zen/go/v1/chat/completions';
const GLM_MODEL = 'glm-5.2';

/** Upper bound on JD text sent to the model, in characters. */
const MAX_JD_CHARS = 6000;

/**
 * Floor for what counts as a job description. Anything shorter is a
 * headline, not a posting body — feeding it to the model as "the full job
 * description" is worse than admitting we have none.
 */
const MIN_JD_CHARS = 120;

/** Cap on what we write back to the description column. */
const MAX_STORED_JD_CHARS = 20000;

/** Budget for the on-demand JD fetch. Generation continues without it. */
const JD_FETCH_TIMEOUT_MS = 10000;

const JD_FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

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

// ── Job description handling ──

/** Casefold + strip punctuation/whitespace, for comparing text for sameness. */
function normalizeForCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when the stored "description" merely restates the job title and
 * carries no posting body.
 *
 * This is a real failure mode, not a hypothetical: a pipeline change once
 * wired the title into the description column, and every row looked
 * populated while carrying nothing a resume could be tailored to. Passing
 * that to the model labelled "FULL JOB DESCRIPTION — source of truth" is
 * actively misleading, so it is treated as absent.
 */
function isTitleOnly(description, title) {
  const d = normalizeForCompare(description);
  const t = normalizeForCompare(title);
  if (!d) return true;
  if (!t) return false;
  if (d === t) return true;
  // A handful of extra words around the title is still a headline.
  if (d.includes(t) && d.length - t.length < 20) return true;
  return false;
}

/**
 * The verbatim JD body, trimmed and length-capped.
 * `description` is the real posting text captured by job_hunt_daily.py.
 * Returns null when the column holds nothing usable — empty, a bare title,
 * or too short to be a posting body.
 * @returns {string|null} JD text, or null when nothing usable exists
 */
function jobDescriptionText(job) {
  const raw = String(job.description || '').trim();
  if (!raw) return null;
  const clean = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return null;
  if (clean.length < MIN_JD_CHARS) return null;
  if (isTitleOnly(clean, job.title)) return null;
  return clean.length > MAX_JD_CHARS
    ? clean.slice(0, MAX_JD_CHARS).trimEnd() + '\n\n[… description truncated]'
    : clean;
}

/**
 * The JD section of the prompt. When no description was captured we say so
 * explicitly rather than silently letting the model invent requirements.
 */
function jobDescriptionBlock(job) {
  const jd = jobDescriptionText(job);
  if (jd) {
    return `
FULL JOB DESCRIPTION (verbatim from the posting — treat this as the source of truth):
"""
${jd}
"""
`;
  }
  return `
FULL JOB DESCRIPTION: not captured for this posting.
Work only from the fields above. Do NOT invent requirements, tools, or
responsibilities that are not stated.
`;
}

/**
 * Fetch the posting page and pull out its body.
 *
 * Structured ingestion normally supplies this. When it does not (LinkedIn's
 * block-prone per-posting detail request is intentionally disabled), fetch it
 * lazily: once, only for a job the user actually clicked Generate on. Public
 * ATS JSON is attempted before HTML.
 *
 * Every failure path returns null and generation proceeds without a JD.
 * @returns {Promise<string|null>}
 */
async function fetchJobDescription(url) {
  if (!isSafePublicHttpUrl(url)) return null;

  // API-first: if ingestion stored the employer's Greenhouse, Lever, Workday,
  // or SmartRecruiters URL, read the public posting endpoint. This avoids a
  // follow-up request to the board that discovered the job.
  const ats = await fetchPublicAtsJob(String(url), {
    timeoutMs: JD_FETCH_TIMEOUT_MS
  });
  if (ats.ok && ats.job.description.length >= MIN_JD_CHARS) {
    return ats.job.description.slice(0, MAX_STORED_JD_CHARS);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JD_FETCH_TIMEOUT_MS);
  try {
    let currentUrl = String(url);
    let res;
    // Validate every redirect rather than allowing a stored URL to bounce the
    // Worker to loopback/private infrastructure.
    for (let hop = 0; hop <= 3; hop++) {
      if (!isSafePublicHttpUrl(currentUrl)) return null;
      res = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': JD_FETCH_UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-CA,en;q=0.9'
        }
      });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get('location');
      if (!location || hop === 3) return null;
      currentUrl = new URL(location, currentUrl).href;
    }
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 500000);
    const hit = extractJobDescription(html);
    return hit ? hit.text : null;
  } catch {
    // Timeout, DNS failure, anti-bot wall — all mean "no JD", not "fail".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
${jobDescriptionBlock(job)}
INSTRUCTIONS:
1. Write the resume in clean Markdown (## for sections, ** for emphasis)
2. Start with a compelling professional summary (3-4 lines) tailored to THIS role
3. Include relevant experience bullet points that map to the job requirements
4. List key skills aligned with the position
5. Mirror the exact terminology, tools, and phrasing used in the job
   description above — recruiters and ATS filters match on those words
6. Prioritise the requirements the description states first or repeats
7. Ground every claim in the candidate profile. Never invent a requirement
   the description does not mention, and never claim experience the profile
   does not support
8. Keep it to one page (concise, impactful bullets)
9. Do NOT include contact details beyond name and location
10. Output ONLY the resume markdown — no preamble, no explanations

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
${jobDescriptionBlock(job)}
INSTRUCTIONS:
1. Write in a professional but warm tone
2. Address it to the hiring manager (use "Dear Hiring Manager" if no name)
3. Open with a strong hook referencing the specific role and company
4. Highlight 2-3 key achievements most relevant to THIS job, chosen to answer
   the requirements the job description actually emphasises
5. Reference at least one concrete detail from the job description so the
   letter could not have been written from the job title alone
6. Show genuine enthusiasm and cultural fit
7. Never claim experience the candidate profile does not support
8. Close with a clear call to action
9. Keep it to 3-4 paragraphs (under 350 words)
10. Output ONLY the cover letter — no preamble, no explanations

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

  // ── 3b. Fetch the JD on demand if the stored one is unusable ──
  // The pipeline can only store the title, so this is where real posting
  // text actually enters the system. One request, for this job only.
  let jdSource = jobDescriptionText(job) ? 'stored' : 'unavailable';
  if (jdSource === 'unavailable' && job.url) {
    const fetched = await fetchJobDescription(job.url);
    if (fetched && fetched.length >= MIN_JD_CHARS && !isTitleOnly(fetched, job.title)) {
      job.description = fetched.slice(0, MAX_STORED_JD_CHARS);
      jdSource = 'fetched';

      // Cache it back so the next generate is instant and the nightly sync
      // can build a real summary from it. Guarded so a genuine stored body
      // is never clobbered — this only fills empty or title-only rows.
      try {
        await tursoExecute(
          env,
          "UPDATE applications SET description=?, updated_at=datetime('now') " +
          "WHERE id=? AND (description IS NULL OR trim(description)='' " +
          "                OR length(trim(description)) < ?)",
          [job.description, jobId, MIN_JD_CHARS]
        );
      } catch (err) {
        // Non-fatal: we still have the text in memory for this generation.
        console.error('JD cache write failed:', err);
      }
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
    const jd = jobDescriptionText(job);
    const jobDetails = JSON.stringify({
      job_id: jobId,
      title: job.title,
      company: job.company,
      location: job.location,
      salary: job.salary,
      track: job.track,
      url: job.url,
      // Record what the model actually saw, so a weak resume can be traced
      // back to a missing or truncated JD rather than guessed at.
      description_used: !!jd,
      // 'stored'      — the pipeline had a usable body
      // 'fetched'     — pulled from the posting URL during this request
      // 'unavailable' — no usable JD; the prompt said so rather than guessing
      description_source: jdSource,
      description: jd,
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
