/**
 * Read one posting through an employer ATS's documented/public JSON endpoint.
 *
 * Adapted from the API-first provider strategy in santifer/career-ops. The
 * endpoint is always derived from an allowlisted ATS hostname; callers never
 * supply an arbitrary API target.
 */

import { htmlToText } from './extract-jd.mjs';
import { isSafePublicHttpUrl } from './job-url.mjs';

const JSON_HEADERS = { accept: 'application/json' };

function segments(url) {
  return url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

function greenhousePlan(url) {
  if (!/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/i.test(url.hostname)) return null;
  const parts = segments(url);
  if (parts[0] === 'boards') parts.shift();
  const jobsIndex = parts.indexOf('jobs');
  if (jobsIndex < 1 || !/^\d+$/.test(parts[jobsIndex + 1] || '')) return null;
  const board = encodeURIComponent(parts[jobsIndex - 1]);
  const id = encodeURIComponent(parts[jobsIndex + 1]);
  return {
    provider: 'greenhouse',
    apiUrl: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?content=true`,
    init: { headers: JSON_HEADERS, redirect: 'error' },
  };
}

function leverPlan(url) {
  const match = url.hostname.match(/^jobs\.(?:(eu)\.)?lever\.co$/i);
  if (!match) return null;
  const [company, id] = segments(url);
  if (!company || !id || !/^[0-9a-f-]{8,}$/i.test(id)) return null;
  const apiHost = match[1] ? 'api.eu.lever.co' : 'api.lever.co';
  return {
    provider: 'lever',
    apiUrl: `https://${apiHost}/v0/postings/${encodeURIComponent(company)}/${encodeURIComponent(id)}`,
    init: { headers: JSON_HEADERS, redirect: 'error' },
  };
}

function workdayPlan(url) {
  const host = url.hostname.match(/^([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com$/i);
  if (!host) return null;
  const parts = segments(url);
  if (/^[a-z]{2}-[a-z]{2}$/i.test(parts[0] || '')) parts.shift();
  const site = parts.shift();
  if (!site || parts[0] !== 'job' || parts.length < 2) return null;
  const externalPath = '/' + parts.map(encodeURIComponent).join('/');
  const origin = `https://${url.hostname}`;
  return {
    provider: 'workday',
    apiUrl: `${origin}/wday/cxs/${encodeURIComponent(host[1])}/${encodeURIComponent(site)}${externalPath}`,
    init: {
      headers: { ...JSON_HEADERS, 'accept-language': 'en-CA,en;q=0.9' },
      redirect: 'error',
    },
  };
}

function smartRecruitersPlan(url) {
  if (url.hostname.toLowerCase() !== 'jobs.smartrecruiters.com') return null;
  const [company, slug] = segments(url);
  const id = slug?.match(/^(\d{8,})/)?.[1];
  if (!company || !id) return null;
  return {
    provider: 'smartrecruiters',
    apiUrl: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${id}`,
    init: { headers: JSON_HEADERS, redirect: 'error' },
  };
}

/** Return the allowlisted public API request for a recognized posting URL. */
export function resolvePublicAtsRequest(value) {
  if (!isSafePublicHttpUrl(value)) return null;
  const url = new URL(value);
  return greenhousePlan(url) || leverPlan(url) || workdayPlan(url) || smartRecruitersPlan(url);
}

function joinText(parts) {
  const seen = new Set();
  return parts
    .map((part) => htmlToText(String(part || '')).trim())
    .filter((part) => part.length > 0 && !seen.has(part) && seen.add(part))
    .join('\n\n')
    .trim();
}

function parseGreenhouse(json) {
  return {
    title: json?.title || '',
    location: json?.location?.name || '',
    canonicalUrl: json?.absolute_url || '',
    description: joinText([json?.content]),
  };
}

function parseLever(json) {
  const listText = Array.isArray(json?.lists) ? json.lists.map((item) => item?.content) : [];
  return {
    title: json?.text || '',
    location: json?.categories?.location || '',
    canonicalUrl: json?.hostedUrl || '',
    description: joinText([json?.descriptionPlain, ...listText, json?.additionalPlain]),
  };
}

function parseWorkday(json) {
  const info = json?.jobPostingInfo || json?.jobInfo || json || {};
  return {
    title: info.title || json?.title || '',
    location: info.location || info.locationText || json?.location || '',
    canonicalUrl: info.externalUrl || info.jobPostingUrl || '',
    description: joinText([info.jobDescription, info.description, json?.jobDescription]),
  };
}

function parseSmartRecruiters(json) {
  const sections = json?.jobAd?.sections || {};
  return {
    title: json?.name || '',
    location: [json?.location?.city, json?.location?.region, json?.location?.country]
      .filter(Boolean).join(', '),
    canonicalUrl: json?.ref || '',
    description: joinText([
      sections.companyDescription?.text,
      sections.jobDescription?.text,
      sections.qualifications?.text,
      sections.additionalInformation?.text,
    ]),
  };
}

export function parsePublicAtsJob(provider, json) {
  if (provider === 'greenhouse') return parseGreenhouse(json);
  if (provider === 'lever') return parseLever(json);
  if (provider === 'workday') return parseWorkday(json);
  if (provider === 'smartrecruiters') return parseSmartRecruiters(json);
  return null;
}

/**
 * Fetch and normalize a recognized public ATS posting.
 *
 * A supported-but-unavailable result is returned explicitly so liveness can
 * distinguish HTTP 404/410 from a parser miss or temporary network failure.
 */
export async function fetchPublicAtsJob(value, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const request = resolvePublicAtsRequest(value);
  if (!request) return { supported: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(request.apiUrl, {
      ...request.init,
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        supported: true,
        ok: false,
        provider: request.provider,
        status: response.status,
        reason: `public ATS returned HTTP ${response.status}`,
      };
    }
    const json = await response.json();
    const job = parsePublicAtsJob(request.provider, json);
    if (!job?.description) {
      return {
        supported: true,
        ok: false,
        provider: request.provider,
        status: response.status,
        reason: 'public ATS response had no job description',
      };
    }
    return { supported: true, ok: true, provider: request.provider, status: response.status, job };
  } catch (error) {
    return {
      supported: true,
      ok: false,
      provider: request.provider,
      status: 0,
      reason: error?.name === 'AbortError' ? 'public ATS timeout' : `public ATS error: ${error.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
