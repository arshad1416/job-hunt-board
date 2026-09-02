#!/bin/zsh
# ego-linkedin-enrich.sh — fill hiring_manager from LinkedIn job pages.
#
# Runs on the Mac (NOT the Pi): ego-browser drives the user's logged-in
# LinkedIn session, so this borrows a real browser rather than scraping
# headless. Reads the "People you can reach out to" / "Meet the hiring
# team" panel and writes the applications.hiring_manager column over
# Turso HTTP.
#
# Usage:
#   scripts/ego-linkedin-enrich.sh [--limit N] [--commit] [--job-id ID]
#     --limit N   how many jobs to visit (default 10)
#     --commit    write results (default: dry-run, prints only)
#     --job-id    enrich one specific job regardless of NULL state
#
# Env: TURSO_URL/TURSO_TOKEN if already exported; otherwise the token is
# read from the Pi via ssh (host "pi"), matching the pipeline convention.
#
# Quirk: ego's nodejs runtime prints console.log to a stream that does not
# survive a pipe, so per-run stderr is captured to a temp file instead.
set -uo pipefail

LIMIT=10; COMMIT=0; JOB_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --commit) COMMIT=1; shift ;;
    --job-id) JOB_ID="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
REPO_ROOT="${0:A:h:h}"

if [[ -z "${TURSO_URL:-}" ]]; then export TURSO_URL="https://morning-briefing-arshad1416.aws-us-east-1.turso.io"; fi
if [[ -z "${TURSO_TOKEN:-}" ]]; then export TURSO_TOKEN="$(ssh pi 'cat ~/.hermes/turso_token.txt')"; fi

if [[ -n "$JOB_ID" ]]; then
  WHERE="id=${JOB_ID}"
else
  WHERE="hiring_manager IS NULL AND url LIKE '%linkedin.com/jobs%'"
fi

node --input-type=module -e "
import { tursoQuery } from '${REPO_ROOT}/scripts/lib/turso.mjs';
const rows = await tursoQuery(process.env, \"SELECT id, title, company, url FROM applications WHERE ${WHERE} ORDER BY match_score DESC LIMIT ${LIMIT}\");
console.log(JSON.stringify(rows));
" | node -e '
const rows = JSON.parse(require("fs").readFileSync(0));
for (const r of rows) console.log(JSON.stringify(r));' | while read -r JOB; do
  ID=$(echo "$JOB" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).id)')
  URL=$(echo "$JOB" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).url)')
  TITLE=$(echo "$JOB" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).title)')

  echo "--- [${ID}] ${TITLE}"

  EGO_ERR="$(mktemp /tmp/ego-enrich.XXXXXX.err)"
  ego-browser nodejs <<EOF 2>"${EGO_ERR}" >/dev/null
const task = await useOrCreateTaskSpace('linkedin hiring manager enrichment');
await gotoAndWait('${URL}', { timeout: 40 });
await wait(4);
const found = await js(String.raw\`(() => {
  const NON_PERSON = new Set(['The','Our','A','An','This','Team','Recruitment','Recruiting','Hiring','Talent','People','Canada','Canadian','Regional','National','Candidates','Applicants','LinkedIn','Member']);
  // The hiring-team panel carries profile links whose text glues the name
  // to metadata ("Juliana Chavez 3rdPsychologist | ..."), so split on the
  // bullet/newline and validate a strict two-capitalized-word shape.
  const isName = s => { const w = String(s).split(' '); return w.length <= 2 && w.every(x => { const m = /^[A-Z][a-zA-Z.'-]+/.exec(x); return m && m[0] === x; }); };
  const cards = [...document.querySelectorAll('a[href*="/in/"]')].map(a => a.textContent || '');
  const clean = [...new Set(cards.map(c => c.split(/[•\\n]/)[0].trim()).filter(c => isName(c) && !NON_PERSON.has(c.split(' ')[0])))];
  return clean[0] || '';
})()\`);
await wait(2);
console.log(JSON.stringify({ job_id: '${ID}', name: found || null }));
EOF
  NAME="$(node -e 'const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean); for (let i = lines.length - 1; i >= 0; i--) { try { const v = JSON.parse(lines[i]).name; if (v) { console.log(v); process.exit(0); } } catch {} } console.log("")' "${EGO_ERR}")"
  rm -f "${EGO_ERR}"
  if [[ -z "$NAME" ]]; then
    echo "    no confident name found (wall, panel absent, or non-person); skipping"
  elif [[ "$COMMIT" -eq 1 ]]; then
    node "${REPO_ROOT}/scripts/set-hiring-manager.mjs" "$ID" "$NAME" --commit | tail -1
  else
    echo "    dry-run: would set hiring_manager = ${NAME}"
  fi

  # Human-paced jitter between visits.
  SLEEP=$(( 5 + RANDOM % 6 ))
  sleep ${SLEEP}
done

echo "done (commit=${COMMIT})."
