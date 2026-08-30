/* ═══════════════════════════════════════════════════════════════
   Signed material links — HMAC-SHA256, time-limited

   Browser tabs cannot send an X-Auth-Token header, which is why
   /api/materials/* used to be public. Instead of leaving it open,
   the dashboard asks an authenticated endpoint for a short-lived
   signed URL and navigates to that.

   Token format:  v1.<exp>.<base64url(hmac)>
   Signed payload: v1:<job_id>:<filename>:<exp>
   Key:            MATERIALS_SIGNING_KEY, else DASHBOARD_AUTH_TOKEN
   ═══════════════════════════════════════════════════════════════ */

const TOKEN_VERSION = 'v1';
const DEFAULT_TTL_SECONDS = 900; // 15 minutes

/** Files the dashboard can be handed links for. */
const MATERIAL_FILES = ['resume.md', 'cover_letter.md', 'job_details.json', 'resume.pdf', 'cover_letter.pdf'];
const MATERIAL_ROUTE = '/api/materials';

const encoder = new TextEncoder();

function signingSecret(env) {
  return env.MATERIALS_SIGNING_KEY || env.DASHBOARD_AUTH_TOKEN || '';
}

function base64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

/**
 * Compare two strings without leaking where they diverge.
 * Length is not secret here (both are fixed-format), so the early
 * return on mismatched length is fine.
 */
function timingSafeEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a signed token for one (job_id, filename) pair.
 * @returns {Promise<string>} token to pass as ?token=
 */
async function signMaterialsToken(env, jobId, filename, ttlSeconds = DEFAULT_TTL_SECONDS, materialVersion = null) {
  const secret = signingSecret(env);
  if (!secret) {
    throw new Error('No signing secret configured (MATERIALS_SIGNING_KEY or DASHBOARD_AUTH_TOKEN)');
  }
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmac(secret, `${TOKEN_VERSION}:${jobId}:${materialVersion || '-'}:${filename}:${exp}`);
  return `${TOKEN_VERSION}.${exp}.${sig}`;
}

/**
 * Verify a token against the exact (job_id, filename) being requested.
 * A token minted for job 41 will not open job 42, and expires on its own.
 * @returns {Promise<boolean>}
 */
async function verifyMaterialsToken(env, jobId, filename, token, materialVersion = null) {
  const secret = signingSecret(env);
  if (!secret || !token) return false;

  const parts = String(token).split('.');
  if (parts.length !== 3) return false;

  const [version, expRaw, sig] = parts;
  if (version !== TOKEN_VERSION) return false;
  if (!/^\d+$/.test(expRaw)) return false;

  const exp = parseInt(expRaw, 10);
  if (Math.floor(Date.now() / 1000) >= exp) return false;

  const expected = await hmac(secret, `${TOKEN_VERSION}:${jobId}:${materialVersion || '-'}:${filename}:${exp}`);
  return timingSafeEqual(sig, expected);
}

/**
 * Build the full set of signed material URLs for one job.
 * @returns {Promise<{resume: string, cover_letter: string, job_details: string}>}
 */
async function signedMaterialUrls(env, jobId, ttlSeconds = DEFAULT_TTL_SECONDS, materialVersion = null) {
  const prefix = materialVersion ? `/api/materials/${jobId}/versions/${materialVersion}` : `/api/materials/${jobId}`;
  const [resume, cover, details] = await Promise.all(MATERIAL_FILES.map(f => signMaterialsToken(env, jobId, f, ttlSeconds, materialVersion)));
  return {
    resume: `${prefix}/resume.md?token=${resume}`,
    cover_letter: `${prefix}/cover_letter.md?token=${cover}`,
    job_details: `${prefix}/job_details.json?token=${details}`
  };
}

export {
  signMaterialsToken,
  verifyMaterialsToken,
  signedMaterialUrls,
  timingSafeEqual,
  MATERIAL_FILES,
  DEFAULT_TTL_SECONDS
};
