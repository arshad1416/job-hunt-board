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
#   ./scripts/run-phase2.sh --yes      # no prompts; approves writes + deploy
#
# Interactive mode is intentionally refused when stdin is not a terminal. A
# previous SSH run hit EOF at every prompt, skipped every write, and still
# reached the final verifier as though the procedure had run.
set -euo pipefail

YES=0
case "${1:-}" in
  "") ;;
  --yes) YES=1 ;;
  -h|--help)
    sed -n '2,22p' "$0"
    exit 0
    ;;
  *)
    echo "Unknown argument: $1 (expected --yes or --help)" >&2
    exit 64
    ;;
esac

if [[ $YES -eq 0 && ! -t 0 ]]; then
  echo "Interactive mode requires a terminal; stdin is not a TTY." >&2
  echo "Run this from an interactive shell, or review the dry-run safeguards" >&2
  echo "and pass --yes to approve the writes and production deploy." >&2
  exit 64
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

confirm() {
  [[ $YES -eq 1 ]] && return 0
  local a
  if ! read -rp "$1 [y/N] " a; then
    warn "Could not read confirmation; stopping without approving this step."
    return 1
  fi
  [[ "$a" == [yY] ]]
}

run_fetch_step() {
  local label="$1"
  shift
  local rc=0
  "$@" || rc=$?
  if [[ $rc -eq 2 ]]; then
    warn "Another fetching run holds the lock during $label. Wait for it, or"
    warn "re-run with --force only after confirming that pid is gone."
    exit 2
  fi
  if [[ $rc -ne 0 ]]; then
    warn "$label failed (exit $rc); stopping."
    exit "$rc"
  fi
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
run_fetch_step "liveness dry run" node scripts/check-liveness.mjs --limit 50

if confirm $'\nDo the expired verdicts look right? Commit them?'; then
  run_fetch_step "liveness commit" node scripts/check-liveness.mjs --limit 50 --commit
else
  echo "skipped — nothing written"
fi

# ── 2. Descriptions ──────────────────────────────────────────────────────────
bold "2/3  DESCRIPTIONS — dry run, writes nothing"
warn "A low hit rate is expected, for the same anti-bot reason."
run_fetch_step "description dry run" \
  node scripts/backfill-descriptions.mjs --limit 50 --order score

if confirm $'\nHit rate worth committing?'; then
  run_fetch_step "description commit" \
    node scripts/backfill-descriptions.mjs --limit 50 --order score --commit
else
  echo "skipped — nothing written"
fi

# ── 3. Sync + deploy ─────────────────────────────────────────────────────────
bold "3/3  SYNC — rebuild jobs.json and deploy"
SYNC="$HOME/.hermes/scripts/sync_to_dashboard.py"
SYNC_SOURCE="$REPO/sync_to_dashboard.py"
if [[ -f "$SYNC" ]]; then
  if ! cmp -s "$SYNC_SOURCE" "$SYNC"; then
    warn "The cron copy of sync_to_dashboard.py differs from the repo copy."
    if confirm "Back it up and install the current repo copy before syncing?"; then
      SYNC_BACKUP="${SYNC}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
      cp -p "$SYNC" "$SYNC_BACKUP"
      cp "$SYNC_SOURCE" "$SYNC"
      echo "installed current sync script (backup: $SYNC_BACKUP)"
    else
      warn "Refusing to run a stale sync script; nothing was deployed."
      exit 1
    fi
  fi
  if confirm "Run sync_to_dashboard.py (rewrites data/jobs.json and pushes)?"; then
    python3 "$SYNC"
  else
    echo "skipped"
  fi
else
  warn "$SYNC not found — skipping sync"
fi

bold "RESULT"
code=0
node scripts/verify-goal.mjs || code=$?

bold "NEXT"
echo "Criterion 3 also goes green the first time you click Generate on a job:"
echo "the Worker fetches that posting's real description and caches it."
echo "Check job_details.json afterwards — description_source should read 'fetched'."
exit $code
