#!/usr/bin/env node
/**
 * backfill-descriptions.mjs — fill applications.description for rows that
 * predate the column.
 *
 * This is the SECONDARY path. The primary fix is job_hunt_daily.py storing
 * the description at scrape time, where the text is already in hand and no
 * extra request is needed — see docs/PHASE2_RUNBOOK.md. Use this only to
 * repair history, and expect a low hit rate: LinkedIn and Indeed wall
 * headless requests, and a walled page yields no description at all.
 *
 * Same safety posture as check-liveness.mjs:
 *   - DRY RUN BY DEFAULT; writing needs --commit
 *   - --limit defaults to 50
 *   - sequential with a jittered per-host delay; a repeatedly-blocked host
 *     is abandoned rather than hammered
 *   - never writes an empty or implausibly short description
 *
 * Usage:
 *   export TURSO_URL=... TURSO_TOKEN=...
 *   node scripts/backfill-descriptions.mjs                     # dry run, 50
 *   node scripts/backfill-descriptions.mjs --limit 50 --commit
 *
 * Exit code: 0 on a clean run, 1 on a fatal error.
 */

import { tursoQuery, tursoExecute, hasColumn } from './lib/turso.mjs';
import { jitteredDelayMs, sleep } from './lib/liveness.mjs';
import { extractJobDescription } from './lib/extract-jd.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const DEFAULTS = {
  limit: 50,
  throttleMs: 5000,
  timeoutMs: 20000,
  minChars: 200,
  maxChars: 20000,
  maxFailuresPerHost: 5
};

function parseArgs(argv) {
  const o = { ...DEFAULTS, commit: false, json: false, host: null, status: 'found' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--dry-run') o.commit = false;
    else if (a === '--json') o.json = true;
    else if (a === '--limit') o.limit = parseInt(next(), 10);
    else if (a === '--throttle') o.throttleMs = parseInt(next(), 10);
    else if (a === '--timeout') o.timeoutMs = parseInt(next(), 10);
    else if (a === '--min-chars') o.minChars = parseInt(next(), 10);
    else if (a === '--status') o.status = next();
    else if (a === '--host') o.host = next();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (Number.isNaN(o.limit) || o.limit < 0) throw new Error('--limit must be >= 0');
  return o;
}

const HELP = `
backfill-descriptions.mjs — fill applications.description for old rows

  --commit          actually write to Turso (default: dry run)
  --limit N         rows to attempt, 0 = no limit (default 50)
  --status S        only rows in this status (default 'found')
  --host H          only rows whose URL host contains H
  --throttle MS     base per-host delay, jittered to 1-2x (default 5000)
  --timeout MS      per-request timeout (default 20000)
  --min-chars N     reject anything shorter than this (default 200)
  --json            emit a JSON report on stdout
  -h, --help        this text

Requires TURSO_URL and TURSO_TOKEN. Run the migration first:
  node scripts/add-description-column.mjs --confirm
`.trim();

async function fetchCandidates(env, o) {
  const args = [o.status];
  let sql =
    `SELECT id, company, title, url ` +
    `FROM applications ` +
    `WHERE status = ? ` +
    `  AND url IS NOT NULL AND url != '' ` +
    `  AND (description IS NULL OR trim(description) = '') `;
  if (o.host) {
    sql += `  AND url LIKE ? `;
    args.push(`%${o.host}%`);
  }
  sql += `ORDER BY id DESC`;
  if (o.limit > 0) {
    sql += ` LIMIT ?`;
    args.push(o.limit);
  }
  return tursoQuery(env, sql, args);
}

async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-CA,en;q=0.9'
      }
    });
    const body = (await res.text().catch(() => '')).slice(0, 500000);
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: '', error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'unknown'; }
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message + '\n\n' + HELP);
    process.exit(1);
  }
  if (o.help) { console.log(HELP); return; }

  const env = process.env;
  const log = o.json ? () => {} : (...a) => console.log(...a);

  if (!(await hasColumn(env, 'applications', 'description'))) {
    console.error(
      'applications.description does not exist yet.\n' +
      'Run:  node scripts/add-description-column.mjs --confirm'
    );
    process.exit(1);
  }

  const rows = await fetchCandidates(env, o);
  log(`\nattempting ${rows.length} row(s)  [throttle ~${o.throttleMs / 1000}-${(o.throttleMs * 2) / 1000}s]`);
  log(o.commit
    ? '\x1b[33mCOMMIT MODE — descriptions will be written\x1b[0m\n'
    : 'dry run — nothing will be written (pass --commit to apply)\n');

  const failuresByHost = new Map();
  const abandoned = new Set();
  const report = [];
  let filled = 0, missed = 0, written = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const host = hostOf(row.url);

    if (abandoned.has(host)) {
      missed++;
      report.push({ id: row.id, ok: false, reason: `skipped — ${host} abandoned` });
      continue;
    }

    const res = await fetchHtml(row.url, o.timeoutMs);
    let extracted = null;
    let reason;

    if (res.error) {
      reason = `network: ${res.error}`;
    } else if (res.status !== 200) {
      reason = `HTTP ${res.status}`;
    } else {
      const hit = extractJobDescription(res.body);
      if (!hit) {
        reason = 'no description found in page';
      } else if (hit.text.length < o.minChars) {
        reason = `too short (${hit.text.length} < ${o.minChars} chars, via ${hit.via})`;
      } else {
        extracted = hit.text.slice(0, o.maxChars);
        reason = `via ${hit.via}, ${extracted.length} chars`;
      }
    }

    if (extracted) {
      filled++;
      log(`✅ #${String(row.id).padEnd(6)} ${(row.company || '').slice(0, 26).padEnd(26)} ${reason}`);
      if (o.commit) {
        try {
          // Guard the write: only fill rows still empty, so a concurrent
          // job_hunt_daily.py run's fresher text is never clobbered.
          const r = await tursoExecute(
            env,
            `UPDATE applications SET description=?, updated_at=datetime('now') ` +
            `WHERE id=? AND (description IS NULL OR trim(description)='')`,
            [extracted, row.id]
          );
          written += r.affectedRowCount;
        } catch (err) {
          log(`   \x1b[31m↳ write failed for #${row.id}: ${err.message}\x1b[0m`);
        }
      }
    } else {
      missed++;
      log(`⚠️  #${String(row.id).padEnd(6)} ${(row.company || '').slice(0, 26).padEnd(26)} ${reason}`);
      if (res.status === 403 || res.status === 429) {
        const n = (failuresByHost.get(host) || 0) + 1;
        failuresByHost.set(host, n);
        if (n >= o.maxFailuresPerHost) {
          abandoned.add(host);
          log(`   \x1b[33m↳ ${host} blocked ${n}x — abandoning it for this run\x1b[0m`);
        }
      }
    }

    report.push({ id: row.id, ok: !!extracted, reason, chars: extracted?.length ?? 0 });
    if (i < rows.length - 1) await sleep(jitteredDelayMs(o.throttleMs));
  }

  const summary = {
    attempted: rows.length,
    extracted: filled,
    missed,
    committed: o.commit,
    rows_written: written,
    abandoned_hosts: [...abandoned]
  };

  if (o.json) {
    console.log(JSON.stringify({ summary, results: report }, null, 2));
  } else {
    log(`\n${filled} extracted   ${missed} missed`);
    if (o.commit) log(`${written} row(s) written`);
    else if (filled) log(`re-run with --commit to write ${filled} description(s)`);
    if (abandoned.size) {
      log(`\n\x1b[33mabandoned: ${[...abandoned].join(', ')}\x1b[0m`);
    }
    log('\nA low hit rate here is expected and is not the fix — see docs/PHASE2_RUNBOOK.md §3.');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
