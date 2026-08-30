#!/usr/bin/env node
const required = ['TURSO_URL', 'TURSO_TOKEN', 'NINEROUTER_API_KEY', 'DASHBOARD_AUTH_TOKEN', 'JOB_MATERIALS_BUCKET'];
const checks = Object.fromEntries(required.map((name) => [name, Boolean(process.env[name]?.trim())]));
const result = { ok: Object.values(checks).every(Boolean), checks };
if (process.argv.includes('--json')) console.log(JSON.stringify(result));
else { for (const [name, present] of Object.entries(checks)) console.log(name + ': ' + (present ? 'configured' : 'missing')); }
process.exitCode = result.ok ? 0 : 1;
