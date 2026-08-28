/* ═══════════════════════════════════════════════════════════════
   POST /api/followup-draft
   Auth: X-Auth-Token required (enforced by _middleware.js)

   Body: { "job_id": 123, "tone": "professional"|"warm"|"brief" }

   Flow:
   1. Validate numeric job_id + tone allowlist (pure helpers in
      functions/_lib/followup-draft.js)
   2. Fetch company/title/status/follow_up_due/notes from Turso with a
      parameterized query
   3. Reject unknown jobs and statuses where a follow-up no longer
      makes sense (found/saved/materials_ready/rejected/ghosted)
   4. ONE bounded Claude Opus 5 call via 9Router (stream:false) to
      produce an 80-140 word draft
   5. Return { draft, tone, word_count, ... } — no secrets in the
      response body; the API key only ever goes in the auth header.
   ═══════════════════════════════════════════════════════════════ */

import { tursoQuery } from '../_lib/turso.js';
import { isFollowUpEligible, statusLabel } from '../_lib/status.js';
import {
  validateFollowupBody,
  buildFollowupPrompt,
  wordCount
} from '../_lib/followup-draft.js';

const LLM_ENDPOINT = 'https://9router.arshadkazi.ca/v1/chat/completions';
const LLM_MODEL = 'cc/claude-opus-5';

/** One bounded call: short output, generous-but-capped timeout. */
const DRAFT_TIMEOUT_MS = 30000;
const DRAFT_MAX_TOKENS = 500;
const DRAFT_TEMPERATURE = 0.6;

export async function onRequestPost(context) {
  const { request, env } = context;

  // ── 1. Body validation ──
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const check = validateFollowupBody(body);
  if (!check.ok) {
    return json({ error: check.error }, 400);
  }
  const { job_id: jobId, tone } = check;

  // ── 2. Job lookup (parameterized) ──
  let rows;
  try {
    rows = await tursoQuery(
      env,
      'SELECT company, title, status, follow_up_due, notes ' +
      'FROM applications WHERE id = ? LIMIT 1',
      [jobId]
    );
  } catch (err) {
    console.error('followup-draft job lookup error:', err);
    return json({ error: 'Database error: could not load job' }, 500);
  }

  if (!rows || rows.length === 0) {
    return json({ error: 'Job not found: ' + jobId }, 404);
  }
  const job = rows[0];

  // ── 3. Only follow-up-eligible statuses may be drafted ──
  if (!isFollowUpEligible(job.status)) {
    return json(
      {
        error: 'No follow-up appropriate for status "' + statusLabel(job.status) +
               '" (allowed: applied, screening, interview, offer)'
      },
      409
    );
  }

  // ── 4. One bounded draft call ──
  if (!env.NINEROUTER_API_KEY) {
    return json({ error: 'Server LLM not configured (NINEROUTER_API_KEY missing)' }, 503);
  }

  let draft;
  try {
    const res = await fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.NINEROUTER_API_KEY,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
      body: JSON.stringify({
        model: LLM_MODEL,
        stream: false,
        temperature: DRAFT_TEMPERATURE,
        max_tokens: DRAFT_MAX_TOKENS,
        messages: [
          { role: 'user', content: buildFollowupPrompt(job, tone) }
        ]
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('LLM API HTTP ' + res.status + ': ' + text.slice(0, 200));
    }

    const data = await res.json();
    let content = data.choices?.[0]?.message?.content;
    if (Array.isArray(content)) {
      content = content.map(p => (p && typeof p === 'object' ? (p.text || '') : String(p))).join('');
    }
    draft = String(content || '').trim();
    if (!draft) throw new Error('LLM API returned empty content');
  } catch (err) {
    console.error('followup-draft LLM error:', err);
    return json({ error: 'Could not generate follow-up draft' }, 502);
  }

  // ── 5. Response ──
  return json({
    success: true,
    job_id: jobId,
    tone: tone,
    status: job.status,
    label: statusLabel(job.status),
    follow_up_due: job.follow_up_due || null,
    draft: draft,
    word_count: wordCount(draft)
  });
}

/** Helper: JSON response */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
