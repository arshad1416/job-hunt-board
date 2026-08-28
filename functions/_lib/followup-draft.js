/* ═══════════════════════════════════════════════════════════════
   Follow-up draft — pure helpers shared by /api/followup-draft.

   Kept free of Workers-specific imports so the validation, redaction
   and prompt-building logic is unit-testable with plain node
   (see tests/followup-draft.test.mjs).
   ═══════════════════════════════════════════════════════════════ */

/** Accepted tones for the draft, and the default when tone is omitted. */
const TONES = ['professional', 'warm', 'brief'];
const DEFAULT_TONE = 'professional';

/** Personal-data boundary: notes may carry recruiter contact details. */
const MAX_NOTES_CHARS = 500;

/** Anything longer than this is a notes dump, not context. */
const MAX_DRAFT_WORDS = 140;
const MIN_DRAFT_WORDS = 80;

/**
 * Validate the request body. Returns { ok, job_id, tone, error }.
 * job_id must be numeric (number or numeric string); tone must be in
 * the allowlist when present.
 */
function validateFollowupBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid JSON body' };
  }
  const rawId = body.job_id;
  const num = typeof rawId === 'number' ? rawId : parseInt(String(rawId ?? ''), 10);
  if (!Number.isInteger(num) || num <= 0 || String(num) !== String(rawId).trim()) {
    return { ok: false, error: 'Missing or invalid field: job_id (must be numeric)' };
  }
  let tone = DEFAULT_TONE;
  if (body.tone !== undefined && body.tone !== null && body.tone !== '') {
    if (!TONES.includes(body.tone)) {
      return { ok: false, error: 'Invalid tone. Allowed: ' + TONES.join('|') };
    }
    tone = body.tone;
  }
  return { ok: true, job_id: num, tone };
}

/**
 * Redact obvious personal contact details from free text before it is
 * sent to the model: email addresses and phone-number-like sequences.
 * The LLM never needs them to draft a nudge, and the notes field may
 * legitimately hold recruiter contact info.
 */
function redactContacts(text) {
  return String(text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted email]')
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[redacted number]')
    .replace(/https?:\/\/\S+/g, '[redacted link]');
}

/** Clamp notes to a bounded, redacted context string ('' when empty). */
function notesContext(notes) {
  const clean = redactContacts(notes).trim();
  if (!clean) return '';
  return clean.length > MAX_NOTES_CHARS
    ? clean.slice(0, MAX_NOTES_CHARS).trimEnd() + '…'
    : clean;
}

/** Word count for a plain-text draft. */
function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Build the one-shot prompt. Only the bounded job fields supplied here
 * may be used; the model must not invent people, emails, or dates.
 */
function buildFollowupPrompt(job, tone) {
  const notes = notesContext(job.notes);
  return [
    'You write short follow-up messages for a job applicant.',
    '',
    'JOB FACTS (the only context you may use — never invent people,',
    'names, emails, phone numbers, dates, or interview details):',
    '- Company: ' + (job.company || 'the company'),
    '- Role: ' + (job.title || 'the role'),
    '- Application status: ' + (job.status || 'applied'),
    '- Follow-up due date: ' + (job.follow_up_due || 'not specified'),
    notes ? '- Private notes (already redacted): ' + notes : '- Private notes: none',
    '',
    'TONE: ' + tone + (tone === 'brief' ? ' (aim near 80 words)' : ''),
    'Write a ' + tone + ' follow-up message from the candidate to the',
    'hiring team. Greet generically ("Hello") — no personal names.',
    'Reference the role and company, note continued interest, and ask',
    'politely for a status update. Do NOT include signatures, contact',
    'details, placeholders in brackets, or any personal data.',
    'Output ONLY the message text, ' + MIN_DRAFT_WORDS + '-' + MAX_DRAFT_WORDS + ' words.',
    '',
    'Begin:'
  ].join('\n');
}

export {
  TONES,
  DEFAULT_TONE,
  MAX_NOTES_CHARS,
  MIN_DRAFT_WORDS,
  MAX_DRAFT_WORDS,
  validateFollowupBody,
  redactContacts,
  notesContext,
  wordCount,
  buildFollowupPrompt
};
