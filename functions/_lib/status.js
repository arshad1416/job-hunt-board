/* ═══════════════════════════════════════════════════════════════
   Application status vocabulary + pure helpers (portal subset).

   Shared by /api/status, /api/applied and the frontend. Pure ES
   module with no Workers-specific imports so it can be unit-tested
   directly with node (see tests/status.test.mjs).
   ═══════════════════════════════════════════════════════════════ */

/** Full status vocabulary. The first four are the legacy statuses —
 *  every value after them is an additive extension. */
const STATUSES = [
  'found',
  'materials_ready',
  'saved',
  'applied',
  'screening',
  'interview',
  'offer',
  'rejected',
  'ghosted'
];

const VALID_STATUSES = new Set(STATUSES);

/** Statuses that mean "the candidate is (or was) in the pipeline". */
const POST_APPLIED_STATUSES = new Set([
  'applied', 'screening', 'interview', 'offer', 'rejected', 'ghosted'
]);

/** Readable display labels for UI rendering. */
const STATUS_LABELS = {
  found: 'New',
  materials_ready: 'Materials Ready',
  saved: 'Saved',
  applied: 'Applied',
  screening: 'Screening',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  ghosted: 'Ghosted'
};

/** Legacy / alias statuses an old client might still send. */
const STATUS_ALIASES = {
  not_applied: 'found',
  new: 'found'
};

/**
 * Normalize any incoming status string to a canonical one.
 * Returns null when the value is not a string or not recognized.
 */
function normalizeStatus(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  if (VALID_STATUSES.has(key)) return key;
  if (STATUS_ALIASES[key]) return STATUS_ALIASES[key];
  return null;
}

/** True when raw is an acceptable status (canonical or aliased). */
function isValidStatus(raw) {
  return normalizeStatus(raw) !== null;
}

/** Readable label for a (raw or canonical) status; falls back to input. */
function statusLabel(raw) {
  const s = normalizeStatus(raw);
  if (s) return STATUS_LABELS[s];
  return typeof raw === 'string' && raw ? raw : 'Unknown';
}

/** True when the status means the candidate entered (or finished) the pipeline. */
function isPostApplied(status) {
  const s = normalizeStatus(status);
  return s !== null && POST_APPLIED_STATUSES.has(s);
}

/** Statuses where a future follow-up still makes sense. */
const FOLLOW_UP_ELIGIBLE = new Set(['applied', 'screening', 'interview', 'offer']);

/** True when the status is an active pipeline stage (follow-up due applies). */
function isFollowUpEligible(status) {
  const s = normalizeStatus(status);
  return s !== null && FOLLOW_UP_ELIGIBLE.has(s);
}

/** Days after applying before a follow-up becomes due. */
const FOLLOW_UP_DAYS = 7;

/**
 * Compute the follow-up due date for a job, or return the stored one.
 * Returns '' when no follow-up applies (never applied, or dead end).
 *
 * @param {object} job - dashboard job object (jobs.json shape)
 * @returns {string} ISO-ish date string or ''
 */
function followUpDue(job) {
  if (!job || typeof job !== 'object') return '';
  // Follow-ups only apply once the application enters the pipeline.
  // This also prevents a legacy unapply action from displaying a stale
  // due date that was retained for audit history.
  const s = normalizeStatus(job.status);
  if (!isFollowUpEligible(s)) return '';
  // Explicit stored value wins (set by /api/status or sync).
  if (typeof job.follow_up_due === 'string' && job.follow_up_due) {
    return job.follow_up_due;
  }
  // Default: one week after the application went out.
  const appliedAt = job.applied_at || job.applied_date;
  if (!appliedAt) return '';
  let iso = String(appliedAt).replace(' ', 'T');
  // SQLite-style "YYYY-MM-DDTHH:MM:SS" strings are UTC — tag them so
  // Date parses them consistently.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(iso)) iso += 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + FOLLOW_UP_DAYS);
  return d.toISOString().slice(0, 10);
}

/**
 * Derive the urgency / repost / gate indicators for a job from its
 * fields. Missing fields simply yield 'none'/false — old jobs.json
 * files without these keys keep rendering exactly as before.
 *
 * urgency: 'high' | 'medium' | 'none' (high when the posting is fresh
 *          AND flagged urgent, or explicitly marked high urgency).
 * repost:  true when the row (or its URL) is a known repost.
 * gate:    human-readable application gate, '' when none.
 */
function deriveIndicators(job) {
  const out = { urgency: 'none', repost: false, gate: '' };
  if (!job || typeof job !== 'object') return out;

  // Urgency: explicit field first, then a stale-posting heuristic.
  const u = String(job.urgency || '').trim().toLowerCase();
  if (u === 'high' || u === 'medium' || u === 'low') {
    out.urgency = u === 'low' ? 'none' : u;
  }

  const repost = job.is_repost ?? job.repost;
  out.repost = repost === true || repost === 1 || repost === 'true' || repost === '1';

  const gate = job.gate;
  if (typeof gate === 'string' && gate.trim()) {
    out.gate = gate.trim().slice(0, 60);
  }

  return out;
}

export {
  STATUSES,
  STATUS_LABELS,
  STATUS_ALIASES,
  POST_APPLIED_STATUSES,
  FOLLOW_UP_DAYS,
  normalizeStatus,
  isValidStatus,
  statusLabel,
  isPostApplied,
  isFollowUpEligible,
  followUpDue,
  deriveIndicators
};
