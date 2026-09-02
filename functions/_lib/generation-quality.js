import { buildQualityReport, jaccard, tokenize } from './cv-gates.js';

const REUSE_SIMILARITY_THRESHOLD = 0.72;
const REUSE_SCAN_LIMIT = 150;
const MAX_REVIEW_DOCUMENT_CHARS = 24000;

/** Remove a Markdown code fence if a model ignored the output instruction. */
function cleanDocument(value) {
  return String(value || '')
    .trim()
    .replace(/^```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

/** Parse a JSON object, including a fenced or chatty model response. */
function parseReviewerResponse(value) {
  const text = String(value || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/**
 * Parse the delimited reviewer protocol: each rewritten document wrapped in
 * <<<NAME ... >>> markers. A full resume + cover letter JSON-escaped inside
 * one object exceeded the token cap and truncated mid-string, which made
 * every reviewer pass unparseable; plain delimited markdown has no such
 * ceiling. Returns null unless both documents are present.
 */
export function parseReviewerSections(value) {
  const text = String(value || '');
  const grab = (name) => {
    const match = text.match(new RegExp('<<<' + name + '\\s*\\r?\\n?([\\s\\S]*?)>>>', 'i'));
    return match ? match[1].trim() : null;
  };
  const resume = grab('RESUME');
  const cover = grab('COVER_LETTER');
  if (!resume || !cover) return null;
  return { resume, cover_letter: cover, assessment: grab('ASSESSMENT') || '' };
}

/** Rank reports so an LLM revision cannot silently regress grounding. */
function qualityRank(report) {
  return (report?.facts?.ok ? 100000 : 0) -
    (report?.facts?.violations?.length || 0) * 1000 +
    (report?.ats?.score || 0) * 10 +
    (report?.coverFacts?.ok ? 1 : 0);
}

/** Normalize an employer name for the material-reuse safety boundary. */
function employerKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Reuse is same-employer only; similar generic JDs are not interchangeable. */
function sameEmployer(left, right) {
  const a = employerKey(left);
  const b = employerKey(right);
  return Boolean(a && b && a === b);
}

/** Find the closest same-employer posting from a bounded recent-row scan. */
function closestReusableJob(rows, job, minDescriptionChars = 120) {
  const current = tokenize(job?.description || '');
  if (!current.length || !employerKey(job?.company)) return null;
  let best = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!sameEmployer(job?.company, row?.company)) continue;
    const description = String(row?.description || '').trim();
    if (description.length < minDescriptionChars) continue;
    const similarity = jaccard(current, tokenize(description));
    if (similarity >= REUSE_SIMILARITY_THRESHOLD && (!best || similarity > best.similarity)) {
      best = { ...row, similarity };
    }
  }
  return best;
}

/** Legacy artifacts without a quality block remain reusable; partial reports do not. */
function reusableQuality(details) {
  const quality = details?.quality;
  if (!quality) return true;
  return quality.atsPass === true && quality.facts?.ok === true;
}

export {
  REUSE_SIMILARITY_THRESHOLD,
  REUSE_SCAN_LIMIT,
  MAX_REVIEW_DOCUMENT_CHARS,
  cleanDocument,
  parseReviewerResponse,
  qualityRank,
  closestReusableJob,
  reusableQuality,
  employerKey,
  sameEmployer,
  buildQualityReport,
};

/**
 * Deterministic plain-language pass. Em-dashes are the most legible AI tell;
 * the model is told not to use them, and this guarantees the stored Markdown
 * has none regardless: a spaced em-dash between words becomes a comma (the
 * safe general rewrite), any survivors are dropped. En-dashes in ranges
 * (2020–2024) are legitimate typography and stay.
 */
export function plainLanguage(text) {
  return String(text || '')
    .replace(/^##\s+PROFESSIONAL EXPERIENCE\s*$/gm, '## WORK EXPERIENCE')
    .replace(/[ \t]*—[ \t]*/g, ', ')
    .replace(/(\w)—(\w)/g, '$1, $2')
    .replace(/,\s*,/g, ',');
}

const NAME_SHAPE = /^[A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)?$/;
/**
 * Best-effort hiring manager name from the posting body. Only confident
 * shapes are accepted (one or two capitalized words); anything else returns
 * null and the letter falls back to "Dear Hiring Manager,".
 */
export function hiringManagerName(jd) {
  const text = String(jd || '');
  if (!text) return null;
  const patterns = [
    /hiring manager[:\s]+([A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+)?)/i,
    /(?:attention|attn\.?)[:\s]+([A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+)?)/i,
    /(?:reports? to|reporting to)[:\s]+([A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+)?)/i,
    /(?:contact|recruiter)[:\s]+([A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+)?)/i,
  ];
  const NON_PERSON = new Set(['The','Our','A','An','This','Team','Recruitment','Recruiting','Hiring','Talent','People','Canada','Canadian','Regional','National','Candidates','Applicants']);
  for (const re of patterns) {
    const m = text.match(re);
    const name = m && m[1].trim();
    if (name && NAME_SHAPE.test(name) && !NON_PERSON.has(name.split(' ')[0])) return name;
  }
  return null;
}

/** Guarantee the salutation uses the extracted name when one exists. */
export function applySalutation(cover, name) {
  if (!name) return String(cover || '');
  return String(cover || '').replace(/Dear\s+Hiring\s+Manager\s*,/i, 'Dear ' + name + ',');
}
