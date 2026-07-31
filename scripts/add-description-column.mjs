#!/usr/bin/env node
/**
 * add-description-column.mjs — apply migrations/001_add_description_column.sql.
 *
 * Additive and idempotent: checks PRAGMA table_info first, so re-running is
 * a no-op rather than a "duplicate column name" error. Touches no existing
 * column and no existing row.
 *
 * Turso is live production, so this refuses to run without --confirm and
 * prints the backup command first.
 *
 * Usage:
 *   export TURSO_URL=... TURSO_TOKEN=...
 *   node scripts/add-description-column.mjs            # inspect only
 *   node scripts/add-description-column.mjs --confirm  # apply
 */

import { tursoQuery, tursoExecute, hasColumn } from './lib/turso.mjs';

const BACKUP_HINT = `
Back up before applying. Turso is live production:

  turso db shell <db> ".dump" > applications-backup-$(date +%F).sql

Verify the dump is non-empty and contains the applications table:

  grep -c 'INSERT INTO applications' applications-backup-$(date +%F).sql
`.trim();

async function main() {
  const confirm = process.argv.includes('--confirm');
  const env = process.env;

  const already = await hasColumn(env, 'applications', 'description');
  const [{ n: rowCount } = {}] = await tursoQuery(
    env, 'SELECT COUNT(*) AS n FROM applications'
  );

  console.log(`\napplications: ${rowCount} row(s)`);
  console.log(`description column: ${already ? 'present' : 'MISSING'}`);

  if (already) {
    const [stats] = await tursoQuery(
      env,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN description IS NOT NULL AND trim(description) != ''
                       THEN 1 ELSE 0 END) AS populated
       FROM applications`
    );
    console.log(`populated: ${stats.populated || 0} of ${stats.total}`);
    console.log('\nNothing to do — migration already applied.');
    return;
  }

  if (!confirm) {
    console.log('\n' + BACKUP_HINT);
    console.log('\nThen re-run with --confirm to apply:');
    console.log('  ALTER TABLE applications ADD COLUMN description TEXT;');
    console.log('\nNo changes made.');
    return;
  }

  console.log('\napplying: ALTER TABLE applications ADD COLUMN description TEXT;');
  await tursoExecute(env, 'ALTER TABLE applications ADD COLUMN description TEXT');

  if (!(await hasColumn(env, 'applications', 'description'))) {
    throw new Error('column still missing after ALTER — migration did not take');
  }

  const [{ n: after } = {}] = await tursoQuery(
    env, 'SELECT COUNT(*) AS n FROM applications'
  );
  if (after !== rowCount) {
    throw new Error(`row count changed (${rowCount} -> ${after}) — investigate immediately`);
  }

  console.log(`✅ applied. ${after} row(s) intact, all description values NULL.`);
  console.log('\nNext: docs/PHASE2_RUNBOOK.md §3 — capture descriptions on the next scrape.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
