#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REQUIRED_ENV = ['TURSO_URL', 'TURSO_TOKEN', 'NINEROUTER_API_KEY', 'DASHBOARD_AUTH_TOKEN', 'JOB_MATERIALS_BUCKET'];
export const REQUIRED_COMMANDS = ['node', 'pdftotext'];
export function runPreflight(env = process.env, commandExists = (command) => { try { execFileSync('which', [command], { stdio: 'ignore' }); return true; } catch { return false; } }) {
  const checks = Object.fromEntries(REQUIRED_ENV.map((name) => [name, Boolean(env[name]?.trim())]));
  checks.TURSO_URL = checks.TURSO_URL && /^https:\/\//.test(env.TURSO_URL);
  const commands = Object.fromEntries(REQUIRED_COMMANDS.map((name) => [name, commandExists(name)]));
  return { ok: Object.values(checks).every(Boolean) && Object.values(commands).every(Boolean), checks, commands };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runPreflight();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result));
  else { for (const [name, present] of Object.entries(result.checks)) console.log(name + ': ' + (present ? 'configured' : 'missing/invalid')); for (const [name, present] of Object.entries(result.commands)) console.log(name + ': ' + (present ? 'available' : 'missing')); }
  process.exitCode = result.ok ? 0 : 1;
}
