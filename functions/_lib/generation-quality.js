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
    .replace(/\s*```$/i, '')
    .trim();
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
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
