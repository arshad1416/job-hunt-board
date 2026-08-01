#!/usr/bin/env node
/**
 * JSON bridge for jobspy-js.
 *
 * The MCP summary intentionally omits description and job_url_direct. Calling
 * the library once and returning its structured record preserves both fields.
 * LinkedIn's per-posting description fetch remains OFF by default: it adds one
 * request per result and is the path most likely to hit an automated block.
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CANDIDATE_ROOTS = [
  process.env.JOBSPY_JS_PATH,
  '/usr/lib/node_modules/jobspy-js',
  '/Users/arshadkazi/.hermes/node/lib/node_modules/jobspy-js',
].filter(Boolean);

// Kept self-contained so the bridge can also live at ~/.hermes/scripts on the
// Pi. The Worker/maintenance implementation lives in functions/_lib/job-url.mjs.
function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url : null;
  } catch {
    return null;
  }
}

function canonicalJobUrl(job) {
  for (const candidate of [job.job_url_direct, job.url_direct, job.job_url, job.url]) {
    let url = safeUrl(candidate);
    if (!url) continue;
    if (/(?:^|\.)recruitics\.com$/i.test(url.hostname)) {
      const target = safeUrl(url.searchParams.get('rx_url'));
      if (target) {
        url = target;
        for (const key of [...url.searchParams.keys()]) {
          if (/^(?:rx_|utm_)/i.test(key) || key.toLowerCase() === 'source') url.searchParams.delete(key);
        }
      }
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  }
  return '';
}

function plainText(value) {
  return String(value || '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|section|li|ul|ol|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function resolveJobspyLibrary(roots = CANDIDATE_ROOTS) {
  for (const root of roots) {
    const entry = `${root}/dist/index.js`;
    if (existsSync(entry)) return entry;
  }
  return null;
}

export function normalizeJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).map((job) => {
    const sourceUrl = job.job_url || '';
    const canonicalUrl = canonicalJobUrl(job);
    return {
      ...job,
      description: plainText(job.description),
      source_job_url: sourceUrl,
      job_url: canonicalUrl || sourceUrl,
    };
  });
}

function fail(message) {
  process.stderr.write(`[jobspy_json] ${message}\n`);
  process.stdout.write(JSON.stringify({ jobs: [], error: message }));
}

async function main() {
  let args;
  try {
    args = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch (error) {
    fail(`could not parse stdin as JSON: ${error.message}`);
    return;
  }

  const library = resolveJobspyLibrary();
  if (!library) {
    fail(`jobspy-js not found in: ${CANDIDATE_ROOTS.join(', ')}`);
    return;
  }

  let scrapeJobs;
  try {
    ({ scrapeJobs } = await import(pathToFileURL(library).href));
  } catch (error) {
    fail(`could not import ${library}: ${error.message}`);
    return;
  }

  // Pass only the fields used by this pipeline. In particular, no proxy or
  // credential options are accepted through the bridge.
  const options = {
    site_name: args.site_name,
    search_term: args.search_term,
    location: args.location,
    results_wanted: args.results_wanted,
    country_indeed: args.country_indeed,
    hours_old: args.hours_old,
    description_format: args.description_format || 'markdown',
    linkedin_fetch_description: args.linkedin_fetch_description === true,
    indeed_fetch_description: args.indeed_fetch_description === true,
  };

  const started = Date.now();
  try {
    const result = await scrapeJobs(options);
    const jobs = normalizeJobs(Array.isArray(result) ? result : result?.jobs);
    const withDescription = jobs.filter((job) => String(job.description || '').length >= 200).length;
    const withEmployerUrl = jobs.filter((job) => job.job_url && job.job_url !== job.source_job_url).length;
    process.stderr.write(
      `[jobspy_json] ${jobs.length} job(s), ${withDescription} with description, ` +
      `${withEmployerUrl} with employer URL, ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
    );
    process.stdout.write(JSON.stringify({ jobs }));
  } catch (error) {
    fail(`scrapeJobs failed: ${error.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
