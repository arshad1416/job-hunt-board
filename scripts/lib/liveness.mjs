/**
 * Liveness classification — pure functions, no network.
 *
 * Modelled on santifer/career-ops check-liveness.mjs. The load-bearing idea
 * borrowed from it: the result is three-way, and 'uncertain' is NEVER
 * treated as dead. A job board that hides live postings is worse than one
 * that shows a few stale ones, and LinkedIn/Indeed answer headless requests
 * with anti-bot walls that look nothing like a real 404.
 *
 * Everything here is pure so the signals can be unit-tested without hitting
 * a single job board.
 */

export const ACTIVE = 'active';
export const EXPIRED = 'expired';
export const UNCERTAIN = 'uncertain';

/** Phrases that mean the posting is definitively gone. */
const EXPIRED_PHRASES = [
  'no longer accepting applications',
  'no longer accepting application',
  'this job is no longer available',
  'this job is no longer active',
  'this job has expired',
  'this posting has expired',
  'job posting has expired',
  'has expired on indeed',
  'position has been filled',
  'this position is no longer',
  'the job you are looking for is no longer',
  'job not found',
  'posting is no longer available',
  'vacancy is closed',
  'applications are closed'
];

/**
 * Anti-bot / rate-limit walls. These mean "we could not see the page",
 * which is emphatically not the same as "the job is gone".
 */
const BLOCKED_PHRASES = [
  'captcha',
  'are you a human',
  'verify you are human',
  'verifying you are human',
  'unusual traffic',
  'cf-browser-verification',
  'just a moment...',
  'enable javascript and cookies',
  'access to this page has been denied',
  '请稍候',
  'checking your browser'
];

/** Paths a dead posting tends to get bounced to. */
const SEARCH_PATH_MARKERS = [
  '/jobs/search',
  '/jobs/collections',
  '/jobs?',
  '/q-',
  '/browsejobs',
  '/career-advice',
  '/signup',
  '/login',
  '/authwall'
];

function contains(haystack, needles) {
  const lower = haystack.toLowerCase();
  return needles.find(n => lower.includes(n)) || null;
}

/**
 * Pull the posting's identifier out of a URL so we can tell whether a
 * redirect landed on the same posting or bounced us to a listing page.
 * @returns {string|null}
 */
export function postingIdFromUrl(url) {
  try {
    const u = new URL(url);
    // LinkedIn: /jobs/view/4012345678
    const view = u.pathname.match(/\/jobs\/view\/(\d{6,})/);
    if (view) return view[1];
    // Indeed: ?jk=abc123def456
    const jk = u.searchParams.get('jk');
    if (jk) return jk;
    // Adzuna and friends: /details/1234567890
    const details = u.pathname.match(/\/details\/(\d{6,})/);
    if (details) return details[1];
    // Generic trailing numeric id
    const trailing = u.pathname.match(/(\d{7,})\/?$/);
    if (trailing) return trailing[1];
    return null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a fetched posting is still live.
 *
 * @param {object} r
 * @param {string} r.requestUrl   URL we asked for
 * @param {string} r.finalUrl     URL after redirects
 * @param {number} r.status       HTTP status
 * @param {string} r.body         response body (may be '')
 * @returns {{result: string, reason: string}}
 */
export function classify({ requestUrl, finalUrl, status, body = '' }) {
  // ── Hard HTTP verdicts ──
  if (status === 404 || status === 410) {
    return { result: EXPIRED, reason: `HTTP ${status}` };
  }
  if (status === 403 || status === 429) {
    return { result: UNCERTAIN, reason: `HTTP ${status} — blocked or rate-limited` };
  }
  if (status >= 500) {
    return { result: UNCERTAIN, reason: `HTTP ${status} — server error` };
  }
  if (status < 200 || status >= 400) {
    return { result: UNCERTAIN, reason: `HTTP ${status}` };
  }

  // ── Anti-bot wall: we never saw the real page ──
  const blocked = contains(body, BLOCKED_PHRASES);
  if (blocked) {
    return { result: UNCERTAIN, reason: `anti-bot wall (matched "${blocked}")` };
  }

  // ── Explicit "this job is gone" copy ──
  const gone = contains(body, EXPIRED_PHRASES);
  if (gone) {
    return { result: EXPIRED, reason: `page says "${gone}"` };
  }

  // ── Soft 404: bounced off the posting onto a search/login page ──
  if (finalUrl && finalUrl !== requestUrl) {
    const id = postingIdFromUrl(requestUrl);
    const stillOnPosting = id ? finalUrl.includes(id) : false;
    if (!stillOnPosting) {
      const marker = contains(finalUrl, SEARCH_PATH_MARKERS);
      if (marker) {
        return {
          result: EXPIRED,
          reason: `redirected off the posting to ${marker}`
        };
      }
      return {
        result: UNCERTAIN,
        reason: `redirected to a different URL (${finalUrl.slice(0, 120)})`
      };
    }
  }

  // ── An empty body tells us nothing ──
  if (!body || body.trim().length < 500) {
    return { result: UNCERTAIN, reason: 'response body too short to judge' };
  }

  return { result: ACTIVE, reason: 'posting still reachable' };
}

/** Base..2*base ms, so a bulk run doesn't hammer one host on a fixed beat. */
export function jitteredDelayMs(baseMs, rand = Math.random) {
  if (!baseMs) return 0;
  return Math.round(baseMs + rand() * baseMs);
}

export function sleep(ms) {
  return ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
}
