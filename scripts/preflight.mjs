#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromiumPath } from './materials-renderer.mjs';

export const REQUIRED_ENV = ['TURSO_URL', 'TURSO_TOKEN', 'NINEROUTER_API_KEY', 'DASHBOARD_AUTH_TOKEN', 'JOB_MATERIALS_BUCKET', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
export const REQUIRED_COMMANDS = ['node', 'pdftotext', 'pdfinfo'];
function httpsUrlWithHost(value) { try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname); } catch { return false; } }
export function runPreflight(env = process.env, commandExists = (command) => { try { execFileSync('which', [command], { stdio: 'ignore' }); return true; } catch { return false; } }, chromium = chromiumPath) {
  const checks = Object.fromEntries(REQUIRED_ENV.map((name) => [name, Boolean(env[name]?.trim())]));
  checks.TURSO_URL = checks.TURSO_URL && httpsUrlWithHost(env.TURSO_URL);
  checks.R2_ENDPOINT = checks.R2_ENDPOINT && httpsUrlWithHost(env.R2_ENDPOINT);
  const commands = Object.fromEntries(REQUIRED_COMMANDS.map((name) => [name, commandExists(name)]));
  // chromiumPath probes CHROMIUM_BIN and the well-known names with --version,
  // so a configured-but-nonexistent binary fails here instead of at render time.
  commands.chromium = Boolean(chromium(env));
  return { ok: Object.values(checks).every(Boolean) && Object.values(commands).every(Boolean), checks, commands };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runPreflight();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result));
  else { for (const [name, present] of Object.entries(result.checks)) console.log(name + ': ' + (present ? 'configured' : 'missing/invalid')); for (const [name, present] of Object.entries(result.commands)) console.log(name + ': ' + (present ? 'available' : 'missing')); }
  process.exitCode = result.ok ? 0 : 1;
}
