#!/usr/bin/env node
// Set or clear the manually editable hiring_manager column for one job.
// Dry-run by default; --commit writes. An empty value clears the field.
//   node scripts/set-hiring-manager.mjs 10180 "Juliana Chavez" --commit
import { tursoQuery, tursoExecute } from './lib/turso.mjs';

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const positional = args.filter(a => a !== '--commit');
const jobId = positional[0];
const name = positional.slice(1).join(' ').trim();
if (!jobId || !/^\d+$/.test(jobId) || positional.length < 2) {
  console.error('usage: node scripts/set-hiring-manager.mjs <job_id> "<name or empty>" [--commit]');
  process.exit(2);
}

const rows = await tursoQuery(process.env, 'SELECT id, title, company, hiring_manager FROM applications WHERE id=?', [jobId]);
if (!rows.length) { console.error('job not found: ' + jobId); process.exit(1); }
const job = rows[0];
const value = name ? name : null;
console.log(JSON.stringify({ job_id: job.id, title: job.title, company: job.company, current: job.hiring_manager || null, next: value, commit }));
if (commit) {
  const result = await tursoExecute(process.env, 'UPDATE applications SET hiring_manager=?, updated_at=datetime(\'now\') WHERE id=?', [value, jobId]);
  console.log(JSON.stringify({ written: Number(result.affectedRowCount) === 1 }));
}
