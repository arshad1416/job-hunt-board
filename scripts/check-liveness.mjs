#!/usr/bin/env node
/**
 * check-liveness.mjs — mark dead job postings 'expired' in Turso.
 *
 * Modelled on santifer/career-ops check-liveness.mjs, minus Playwright:
 * the Pi runs a Python pipeline and this repo has no build step, so this is
 * a zero-dependency Node 18+ script using global fetch.
 *
 * Safety posture, in order of importance:
 *   1. DRY RUN BY DEFAULT. Writing to Turso needs an explicit --commit.
 *   2. 'uncertain' is never written. Only a definitive dead signal moves a
 *      row to 'expired'. LinkedIn and Indeed answer headless requests with
 *      anti-bot walls, and a wall must never cost you a live posting.
 *   3. Sequential, with a jittered per-host delay. This checks URLs you
 *      already have — it is not a scrape — but it still must not look like
 *      one. Consecutive blocks on a host abandon that host entirely.
 *   4. --limit defaults to 50, matching the "test on <=50 rows first" rule.
 *
 * Usage:
 *   export TURSO_URL=... TURSO_TOKEN=...
 *   node scripts/check-liveness.mjs                      # dry run, 50 rows
 *   node scripts/check-liveness.mjs --limit 50 --commit  # write 50 rows
 *   node scripts/check-liveness.mjs --limit 0 --commit   # full pass
 *
 * Exit code: 0 on a clean run, 1 on a fatal error.
 */

import { tursoQuery, tursoExecute } from './lib/turso.mjs';
import {
  classify, jitteredDelayMs, sleep, ACTIVE, EXPIRED, UNCERTAIN
} from './lib/liveness.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const DEFAULTS = {
  limit: 50,
  minAgeDays: 31,
  maxAgeDays: 60,
  status: 'found',
  throttleMs: 5000,
  timeoutMs: 20000,
  maxBlockedPerHost: 5
};

function parseArgs(argv) {
  const o = { ...DEFAULTS, commit: false, json: false, host: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--dry-run') o.commit = false;
    else if (a === '--json') o.json = true;
    else if (a === '--limit') o.limit = parseInt(next(), 10);
    else if (a === '--min-age-days') o.minAgeDays = parseInt(next(), 10);
    else if (a === '--max-age-days') o.maxAgeDays = parseInt(next(), 10);
    else if (a === '--status') o.status = next();
    else if (a === '--throttle') o.throttleMs = parseInt(next(), 10);
    else if (a === '--timeout') o.timeoutMs = parseInt(next(), 10);
    else if (a === '--host') o.host = next();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (Number.isNaN(o.limit) || o.limit < 0) throw new Error('--limit must be >= 0');
  return o;
}

const HELP = `
check-liveness.mjs — mark dead job postings 'expired'

  --commit             actually write to Turso (default: dry run)
  --limit N            rows to check, 0 = no limit (default 50)
  --min-age-days N     only rows at least this old (default 31)
  --max-age-days N     only rows at most this old (default 60)
  --status S           only rows in this status (default 'found')
  --host H             only rows whose URL host contains H
  --throttle MS        base per-host delay, jittered to 1-2x (default 5000)
  --timeout MS         per-request timeout (default 20000)
  --json               emit a JSON report on stdout
  -h, --help           this text

Requires TURSO_URL and TURSO_TOKEN in the environment.
`.trim();

/** Rows in the age window that are still marked live. */
async function fetchCandidates(env, o) {
  const args = [o.status, o.maxAgeDays, o.minAgeDays];
  let sql =
    `SELECT id, company, title, url, status, found_at ` +
    `FROM applications ` +
    `WHERE status = ? ` +
    `  AND url IS NOT NULL AND url != '' ` +
    `  AND found_at >= datetime('now', '-' || ? || ' days') ` +
    `  AND found_at <= datetime('now', '-' || ? || ' days') `;
  if (o.host) {
    sql += `  AND url LIKE ? `;
    args.push(`%${o.host}%`);
  }
  sql += `ORDER BY found_at ASC`;
  if (o.limit > 0) {
    sql += ` LIMIT ?`;
    args.push(o.limit);
  }
  return tursoQuery(env, sql, args);
}

async function probe(url, timeoutMs) {
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
    // Cap the read: some postings are megabytes and we only need the copy.
    const body = (await res.text().catch(() => '')).slice(0, 200000);
    return { status: res.status, finalUrl: res.url || url, body };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    return { status: 0, finalUrl: url, body: '', networkError: reason };
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

  const rows = await fetchCandidates(env, o);
  log(
    `\nchecking ${rows.length} posting(s)  ` +
    `[status=${o.status}, age ${o.minAgeDays}-${o.maxAgeDays}d, ` +
    `throttle ~${o.throttleMs / 1000}-${(o.throttleMs * 2) / 1000}s]`
  );
  log(o.commit
    ? '\x1b[33mCOMMIT MODE — dead postings will be written as expired\x1b[0m\n'
    : 'dry run — nothing will be written (pass --commit to apply)\n');

  const counts = { [ACTIVE]: 0, [EXPIRED]: 0, [UNCERTAIN]: 0 };
  const blockedByHost = new Map();
  const abandonedHosts = new Set();
  const report = [];
  let written = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const host = hostOf(row.url);

    if (abandonedHosts.has(host)) {
      counts[UNCERTAIN]++;
      report.push({ id: row.id, url: row.url, result: UNCERTAIN, reason: `skipped — ${host} abandoned` });
      continue;
    }

    const res = await probe(row.url, o.timeoutMs);
    const verdict = res.networkError
      ? { result: UNCERTAIN, reason: `network: ${res.networkError}` }
      : classify({ requestUrl: row.url, finalUrl: res.finalUrl, status: res.status, body: res.body });

    counts[verdict.result]++;
    report.push({ id: row.id, url: row.url, company: row.company, title: row.title, ...verdict });

    const icon = { [ACTIVE]: '✅', [EXPIRED]: '❌', [UNCERTAIN]: '⚠️ ' }[verdict.result];
    log(`${icon} ${verdict.result.padEnd(9)} #${String(row.id).padEnd(6)} ${(row.company || '').slice(0, 28).padEnd(28)} ${verdict.reason}`);

    // Back off a host that keeps walling us — those rows are unjudgeable,
    // and hammering past a wall is how you earn a real rate-limit.
    if (verdict.result === UNCERTAIN && /blocked|rate-limited|anti-bot/.test(verdict.reason)) {
      const n = (blockedByHost.get(host) || 0) + 1;
      blockedByHost.set(host, n);
      if (n >= o.maxBlockedPerHost) {
        abandonedHosts.add(host);
        log(`   \x1b[33m↳ ${host} blocked ${n}x — abandoning it for this run\x1b[0m`);
      }
    }

    // Only a definitive dead signal ever writes.
    if (verdict.result === EXPIRED && o.commit) {
      try {
        const r = await tursoExecute(
          env,
          `UPDATE applications SET status='expired', updated_at=datetime('now') ` +
          `WHERE id=? AND status=?`,
          [row.id, o.status]
        );
        written += r.affectedRowCount;
      } catch (err) {
        log(`   \x1b[31m↳ write failed for #${row.id}: ${err.message}\x1b[0m`);
      }
    }

    if (i < rows.length - 1) await sleep(jitteredDelayMs(o.throttleMs));
  }

  const summary = {
    checked: rows.length,
    active: counts[ACTIVE],
    expired: counts[EXPIRED],
    uncertain: counts[UNCERTAIN],
    committed: o.commit,
    rows_written: written,
    abandoned_hosts: [...abandonedHosts]
  };

  if (o.json) {
    console.log(JSON.stringify({ summary, results: report }, null, 2));
  } else {
    log(`\n${summary.active} active   ${summary.expired} expired   ${summary.uncertain} uncertain`);
    if (o.commit) log(`${written} row(s) marked expired in Turso`);
    else if (summary.expired) log(`re-run with --commit to mark ${summary.expired} row(s) expired`);
    if (abandonedHosts.size) {
      log(`\n\x1b[33mabandoned: ${[...abandonedHosts].join(', ')} — those rows stayed untouched\x1b[0m`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
