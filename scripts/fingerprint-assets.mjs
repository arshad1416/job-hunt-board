#!/usr/bin/env node
// Rewrites the ?v= fingerprint on /app.js and /style.css in index.html to
// the current content hash. Workers static assets serve them with a 4h
// cache, so the fingerprint must change on every release that touches them.
// Run from the repo root before pushing UI changes:
//   node scripts/fingerprint-assets.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';

const html = fs.readFileSync('index.html', 'utf8');
let changed = 0;
const out = html.replace(/(app\.js|style\.css)\?v=[a-f0-9]+/g, (m, file) => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
  changed++;
  return file + '?v=' + hash;
});
if (changed === 0) {
  // First run on an unfingerprinted template: add the query strings.
  const withApp = out.replace('src="/app.js"', 'src="/app.js?v=' + crypto.createHash('sha256').update(fs.readFileSync('app.js')).digest('hex').slice(0, 10) + '"');
  const withCss = withApp.replace('href="/style.css"', 'href="/style.css?v=' + crypto.createHash('sha256').update(fs.readFileSync('style.css')).digest('hex').slice(0, 10) + '"');
  fs.writeFileSync('index.html', withCss);
  console.log(JSON.stringify({ changed: 2, mode: 'initial' }));
} else {
  fs.writeFileSync('index.html', out);
  console.log(JSON.stringify({ changed, mode: 'bump' }));
}
