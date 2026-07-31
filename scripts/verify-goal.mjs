#!/usr/bin/env node
/**
 * verify-goal.mjs — check all seven success criteria against production.
 *
 * Four of the criteria can only be judged from somewhere that can reach
 * live Turso and the live site. Run this on the Pi after working through
 * docs/PHASE2_RUNBOOK.md and it answers, definitively, which ones hold.
 *
 * Read-only. Issues SELECTs and GETs, never writes.
 *
 * Usage:
 *   export TURSO_URL=... TURSO_TOKEN=...
 *   node scripts/verify-goal.mjs
 *   node scripts/verify-goal.mjs --url https://jobs.arshadkazi.ca --json
 *
 * Exit code: 0 if all seven pass, 1 otherwise.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tursoQuery, hasColumn } from './lib/turso.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = { url: 'https://jobs.arshadkazi.ca', json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') o.url = argv[++i];
    else if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') o.help = true;
  }
  return o;
}

async function get(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { headers, redirect: 'manual', signal: controller.signal });
    const body = await res.text().catch(() => '');
    return { status: res.status, headers: res.headers, body };
  } catch (err) {
    return { status: 0, headers: new Headers(), body: '', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 1. Materials are not readable by an unauthenticated caller. */
async function checkMaterialsLocked(o) {
  const ids = [1, 2, 41, 500, 6595];
  const bad = [];
  for (const id of ids) {
    const r = await get(`${o.url}/api/materials/${id}/resume.md`);
    if (r.status !== 401) bad.push(`job_id=${id} returned ${r.status || r.error}`);
    else if (/^#|experience|resume/i.test(r.body)) bad.push(`job_id=${id} leaked body text`);
  }
  return bad.length
    ? { pass: false, detail: bad.join('; ') }
    : { pass: true, detail: `all ${ids.length} enumerated job_ids returned 401` };
}

/** 2. CORS is pinned, not '*'. */
async function checkCorsPinned(o) {
  const evil = await get(`${o.url}/api/health`, { Origin: 'https://evil.example.com' });
  const acao = evil.headers.get('access-control-allow-origin');
  if (acao === '*') return { pass: false, detail: "still wide open: ACAO is '*'" };
  if (acao) return { pass: false, detail: `unknown origin was echoed back: ${acao}` };
  const ok = await get(`${o.url}/api/health`, { Origin: o.url });
  const good = ok.headers.get('access-control-allow-origin');
  if (good !== o.url) {
    return { pass: false, detail: `own origin not allowed (got ${good || 'nothing'}) — dashboard may break` };
  }
  return { pass: true, detail: 'unknown origin gets no ACAO; own origin echoed' };
}

/** 3. description column exists and a real run populated it. */
async function checkDescriptionColumn(env) {
  if (!(await hasColumn(env, 'applications', 'description'))) {
    return { pass: false, detail: 'column missing — runbook §2 not applied' };
  }
  const [s] = await tursoQuery(
    env,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN description IS NOT NULL AND trim(description) != ''
                     THEN 1 ELSE 0 END) AS populated,
            SUM(CASE WHEN found_at >= datetime('now','-2 days')
                      AND description IS NOT NULL AND trim(description) != ''
                     THEN 1 ELSE 0 END) AS recent
     FROM applications`
  );
  const populated = s.populated || 0;
  if (populated === 0) {
    return { pass: false, detail: `column exists but 0 of ${s.total} rows populated — runbook §3 not done` };
  }
  const recent = s.recent || 0;
  return {
    pass: recent > 0,
    detail: recent > 0
      ? `${populated} of ${s.total} populated, ${recent} from the last 2 days (a real run is writing them)`
      : `${populated} of ${s.total} populated, but none in the last 2 days — likely backfill only, not a real job_hunt_daily.py run`
  };
}

/** 4. jobs.json rows carry a non-empty summary. */
async function checkSummaries() {
  let data;
  try {
    data = JSON.parse(await readFile(join(REPO, 'data/jobs.json'), 'utf8'));
  } catch (err) {
    return { pass: false, detail: `could not read data/jobs.json: ${err.message}` };
  }
  const jobs = data.jobs || [];
  const withSummary = jobs.filter(j => (j.summary || '').trim()).length;
  return {
    pass: withSummary > 0,
    detail: `${withSummary} of ${jobs.length} rows have a non-empty summary` +
      (withSummary === 0 ? ' — runbook §3 + §5 not done' : '')
  };
}

/** 5. generate.js sends the JD body to GLM-5.2. */
async function checkGeneratePassesJd() {
  const src = await readFile(join(REPO, 'functions/api/generate.js'), 'utf8');
  const missing = [];
  if (!/function jobDescriptionBlock/.test(src)) missing.push('jobDescriptionBlock() absent');
  const calls = (src.match(/\$\{jobDescriptionBlock\(job\)\}/g) || []).length;
  if (calls < 2) missing.push(`only ${calls}/2 prompts include it`);
  if (!/job\.description/.test(src)) missing.push('never reads job.description');
  return missing.length
    ? { pass: false, detail: missing.join('; ') }
    : { pass: true, detail: 'JD body interpolated into both the resume and cover-letter prompts' };
}

/** 6. The liveness pass has moved dead postings to 'expired'. */
async function checkLiveness(env) {
  const [s] = await tursoQuery(
    env,
    `SELECT SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) AS expired,
            SUM(CASE WHEN status='found'
                      AND found_at <= datetime('now','-31 days')
                      AND found_at >= datetime('now','-60 days')
                     THEN 1 ELSE 0 END) AS stale_found
     FROM applications`
  );
  const expired = s.expired || 0;
  const stale = s.stale_found || 0;
  return {
    pass: expired > 0,
    detail: expired > 0
      ? `${expired} row(s) marked expired; ${stale} still 'found' in the 31-60d window`
      : `0 rows expired, ${stale} still 'found' in the 31-60d window — runbook §6 not run with --commit`
  };
}

/** 7. The daily cron completed cleanly. */
async function checkCron(o) {
  let data;
  try {
    data = JSON.parse(await readFile(join(REPO, 'data/jobs.json'), 'utf8'));
  } catch (err) {
    return { pass: false, detail: `could not read data/jobs.json: ${err.message}` };
  }
  const updated = data.meta?.updated;
  if (!updated) return { pass: false, detail: 'data/jobs.json has no meta.updated' };
  const ageDays = (Date.now() - Date.parse(updated + 'T00:00:00Z')) / 86400000;
  const health = await get(`${o.url}/api/health`);
  let configured = null;
  try { configured = JSON.parse(health.body).configured; } catch {}

  const problems = [];
  if (!(ageDays <= 2)) problems.push(`jobs.json last updated ${updated} (${Math.floor(ageDays)}d ago)`);
  if (health.status !== 200) problems.push(`/api/health returned ${health.status || health.error}`);
  if (configured === false) problems.push('/api/health reports configured=false');

  return problems.length
    ? { pass: false, detail: problems.join('; ') }
    : { pass: true, detail: `jobs.json fresh (${updated}), /api/health 200 and configured` };
}

const CRITERIA = [
  ['materials not served to unauthenticated enumeration', (env, o) => checkMaterialsLocked(o)],
  ['CORS pinned to the domain, not "*"',                  (env, o) => checkCorsPinned(o)],
  ['applications.description exists and a real run fills it', (env) => checkDescriptionColumn(env)],
  ['data/jobs.json rows have non-empty summary',          () => checkSummaries()],
  ['generate.js passes the JD body to GLM-5.2',           () => checkGeneratePassesJd()],
  ['liveness pass marks dead postings expired',           (env) => checkLiveness(env)],
  ['the 9AM ET cron completed cleanly',                   (env, o) => checkCron(o)]
];

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('verify-goal.mjs [--url https://jobs.arshadkazi.ca] [--json]\n' +
                'Read-only. Requires TURSO_URL and TURSO_TOKEN.');
    return;
  }
  const env = process.env;
  const results = [];

  for (const [name, fn] of CRITERIA) {
    let r;
    try {
      r = await fn(env, o);
    } catch (err) {
      r = { pass: false, detail: `check errored: ${err.message}` };
    }
    results.push({ criterion: name, ...r });
  }

  const passed = results.filter(r => r.pass).length;

  if (o.json) {
    console.log(JSON.stringify({ passed, total: results.length, results }, null, 2));
  } else {
    console.log(`\nchecking against ${o.url}\n`);
    results.forEach((r, i) => {
      console.log(`${r.pass ? '\x1b[32m✅' : '\x1b[31m❌'} ${i + 1}. ${r.criterion}\x1b[0m`);
      console.log(`      ${r.detail}`);
    });
    console.log(`\n${passed} of ${results.length} criteria met`);
    if (passed < results.length) console.log('See docs/PHASE2_RUNBOOK.md for the remaining steps.');
  }

  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
