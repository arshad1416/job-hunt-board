#!/usr/bin/env bash
#
# run-phase2.sh — finish criteria 3, 4 and 6 from a machine that can actually
# reach Turso and the job boards (the Pi, or any local box with the token).
#
# The cloud sessions that built this tooling are walled off from Turso,
# jobs.arshadkazi.ca, LinkedIn, Indeed and Adzuna, so none of it could be
# executed there. This script is the whole remaining procedure in one place.
#
# Safety, unchanged from the individual scripts:
#   - every dry run writes NOTHING; you see the verdicts and approve
#   - liveness never writes an 'uncertain' verdict, only definitive deaths
#   - a shared lock makes concurrent fetching runs impossible
#   - --limit 50 throughout, per the "test on <=50 rows first" rule
#
# Usage:
#   ./scripts/run-phase2.sh            # interactive, prompts before each write
#   ./scripts/run-phase2.sh --yes      # no prompts (still dry-runs first)
#
set -uo pipefail

YES=0
[[ "${1:-}" == "--yes" ]] && YES=1

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

confirm() {
  [[ $YES -eq 1 ]] && return 0
  read -rp "$1 [y/N] " a
  [[ "$a" == [yY] ]]
}

# ── Environment ──────────────────────────────────────────────────────────────
: "${TURSO_URL:=https://morning-briefing-arshad1416.aws-us-east-1.turso.io}"
export TURSO_URL

if [[ -z "${TURSO_TOKEN:-}" ]]; then
  # There is no turso CLI on the Pi; turso_helper.py reads this file.
  if [[ -f "$HOME/.hermes/turso_token.txt" ]]; then
    TURSO_TOKEN="$(tr -d '[:space:]' < "$HOME/.hermes/turso_token.txt")"
    export TURSO_TOKEN
  else
    echo "TURSO_TOKEN is not set and ~/.hermes/turso_token.txt does not exist." >&2
    echo "Export TURSO_TOKEN and re-run." >&2
    exit 1
  fi
fi

command -v node >/dev/null || { echo "node not found (need 18+)" >&2; exit 1; }

bold "BASELINE"
node scripts/verify-goal.mjs || true

# ── 1. Liveness ──────────────────────────────────────────────────────────────
bold "1/3  LIVENESS — dry run, writes nothing"
warn "Expect many 'uncertain': ~93% of these URLs are LinkedIn/Indeed, which"
warn "wall headless requests. 'uncertain' is never written. That is by design."
node scripts/check-liveness.mjs --limit 50
rc=$?
if [[ $rc -eq 2 ]]; then
  warn "Another fetching run holds the lock. Wait for it, or re-run with --force"
  warn "only after confirming that pid is gone."
  exit 2
fi

if confirm $'\nDo the expired verdicts look right? Commit them?'; then
  node scripts/check-liveness.mjs --limit 50 --commit
else
  echo "skipped — nothing written"
fi

# ── 2. Descriptions ──────────────────────────────────────────────────────────
bold "2/3  DESCRIPTIONS — dry run, writes nothing"
warn "A low hit rate is expected, for the same anti-bot reason."
node scripts/backfill-descriptions.mjs --limit 50 --order score

if confirm $'\nHit rate worth committing?'; then
  node scripts/backfill-descriptions.mjs --limit 50 --order score --commit
else
  echo "skipped — nothing written"
fi

# ── 3. Sync + deploy ─────────────────────────────────────────────────────────
bold "3/3  SYNC — rebuild jobs.json and deploy"
SYNC="$HOME/.hermes/scripts/sync_to_dashboard.py"
if [[ -f "$SYNC" ]]; then
  if confirm "Run sync_to_dashboard.py (rewrites data/jobs.json and pushes)?"; then
    python3 "$SYNC"
    # Production deploys off master; the sync pushes main, so carry it across.
    git push origin main:master || warn "main:master push failed — do it manually"
  else
    echo "skipped"
  fi
else
  warn "$SYNC not found — skipping sync"
fi

bold "RESULT"
node scripts/verify-goal.mjs
code=$?

bold "NEXT"
echo "Criterion 3 also goes green the first time you click Generate on a job:"
echo "the Worker fetches that posting's real description and caches it."
echo "Check job_details.json afterwards — description_source should read 'fetched'."
exit $code
