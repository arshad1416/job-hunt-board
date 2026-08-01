/**
 * Job URL selection and validation.
 *
 * Job boards are useful discovery indexes, but the employer/ATS URL is the
 * better canonical record: it is where the application actually lives and it
 * avoids a second request to LinkedIn/Indeed when we need the JD or liveness.
 */

const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
];

function normalizedHost(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/**
 * Syntactic public-URL guard shared by the Worker and Node scripts.
 * DNS-level guarding is added by browser-reader.mjs when Chromium is used.
 */
export function isSafePublicHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.username || url.password) return false;

  const host = normalizedHost(url.hostname);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '::' || host === '::1' || /^f[cd][0-9a-f]{0,2}:/i.test(host) || /^fe[89ab][0-9a-f]?:/i.test(host)) {
    return false;
  }
  if (PRIVATE_IPV4.some((pattern) => pattern.test(host))) return false;

  // IPv4-mapped IPv6 in dotted form, e.g. ::ffff:127.0.0.1.
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped && PRIVATE_IPV4.some((pattern) => pattern.test(mapped))) return false;
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    const dotted = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    if (PRIVATE_IPV4.some((pattern) => pattern.test(dotted))) return false;
  }
  return true;
}

/** Remove a known recruitment tracking hop without following it. */
export function unwrapKnownRecruitingRedirect(value) {
  if (!isSafePublicHttpUrl(value)) return null;
  let url = new URL(value);

  // Recruitics puts the employer URL in rx_url. Reading the parameter is both
  // faster and more private than sending a tracking request just to redirect.
  if (/(?:^|\.)recruitics\.com$/i.test(url.hostname)) {
    const target = url.searchParams.get('rx_url');
    if (target && isSafePublicHttpUrl(target)) {
      url = new URL(target);
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:rx_|utm_)/i.test(key) || key.toLowerCase() === 'source') {
          url.searchParams.delete(key);
        }
      }
    }
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

/**
 * Prefer the employer/ATS URL exposed by jobspy, with the board URL as a safe
 * fallback. Returns an empty string if neither candidate is a public URL.
 */
export function canonicalJobUrl(job = {}) {
  for (const candidate of [job.job_url_direct, job.url_direct, job.job_url, job.url]) {
    const clean = unwrapKnownRecruitingRedirect(candidate);
    if (clean) return clean;
  }
  return '';
}
