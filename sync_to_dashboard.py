#!/usr/bin/env python3
"""
sync_to_dashboard.py — Runs after job_hunt_daily.py on Pi.

1. Reads all 'found' + 'materials_ready' + 'applied' jobs from Turso
2. Generates data/jobs.json for the dashboard
3. Git commits + pushes to trigger Cloudflare Pages deploy

Run: python3 ~/.hermes/scripts/sync_to_dashboard.py
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
HERMES_DIR = Path.home() / ".hermes"

sys.path.insert(0, str(SCRIPTS_DIR))
from turso_helper import turso_query

# ── Config ───────────────────────────────────────────────────────────────────
DASHBOARD_REPO_PATH = Path.home() / "job-hunt-board"  # Cloned repo on Pi
DASHBOARD_DATA_DIR = DASHBOARD_REPO_PATH / "data"
DASHBOARD_JOBS_JSON = DASHBOARD_DATA_DIR / "jobs.json"

# ── Fetch from Turso ─────────────────────────────────────────────────────────
BASE_COLUMNS = (
    "id, source, external_id, company, title, location, url, "
    "salary, match_score, track, status, notes, found_at"
)

# Rows in any of these states are still worth showing. 'expired' is
# deliberately absent — the liveness pass moves dead postings there and
# they drop off the board on the next sync.
ACTIVE_STATUSES = "('found', 'materials_ready', 'applied', 'saved')"


def fetch_all_jobs() -> list:
    """Fetch all non-archived jobs, sorted by match_score DESC.

    Tries to include the `description` column and falls back to the base
    column list if it isn't there yet. The migration is additive and may
    not have been applied, and the 9AM cron must not fail over it.
    """
    tail = (
        f"FROM applications "
        f"WHERE status IN {ACTIVE_STATUSES} "
        f"ORDER BY match_score DESC"
    )
    try:
        return turso_query(f"SELECT {BASE_COLUMNS}, description {tail}")
    except Exception as e:
        print(
            f"[sync] 'description' column unavailable ({e}); "
            f"falling back to base columns",
            file=sys.stderr,
        )
        return turso_query(f"SELECT {BASE_COLUMNS} {tail}")


# ── Transform for dashboard ──────────────────────────────────────────────────
def extract_summary(notes: str) -> str:
    """Extract a human-readable summary from the pipe-delimited notes field.

    The Pi stores notes as:
      'Salary Est: $120K-$150K | Suggested Ask: $157K | Summary: <text>'
    We look for an explicit 'Summary:' fragment first, then fall back to the
    last fragment that isn't a salary/ask line. Returns '' when no summary can
    be derived (W10 — previously this always returned '').
    """
    if not notes:
        return ""
    parts = [p.strip() for p in notes.split("|")]
    for part in parts:
        if part.lower().startswith("summary"):
            val = part.split(":", 1)[1].strip() if ":" in part else part
            return val[:200]
    # Fall back to the last fragment that doesn't look like a salary/ask line
    for part in reversed(parts):
        low = part.lower()
        if (part and len(part) > 20
                and not low.startswith("salary")
                and not low.startswith("suggested")
                and not low.startswith("estimated")):
            return part[:200]
    return ""


SUMMARY_MAX = 200

# Floor for what counts as a job description. Shorter than this is a
# headline, not a posting body.
MIN_DESCRIPTION_CHARS = 120


def _normalize_for_compare(s: str) -> str:
    """Casefold and strip punctuation, for comparing text for sameness."""
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def is_title_only(description: str, title: str) -> bool:
    """True when `description` merely restates the job title.

    A pipeline change once wired the title into the description column;
    every row then looked populated while carrying nothing a resume could
    be tailored to. Treat that as no description rather than letting a
    title masquerade as a summary.
    """
    d = _normalize_for_compare(description)
    t = _normalize_for_compare(title)
    if not d:
        return True
    if not t:
        return False
    if d == t:
        return True
    return t in d and len(d) - len(t) < 20

# Boilerplate openers that carry no signal about the actual role.
_BOILERPLATE = re.compile(
    r"^(about (us|the (company|role|team))|company (overview|description)|"
    r"who we are|our (story|mission)|job (description|summary|overview))\b[:\s-]*",
    re.IGNORECASE,
)


def summarize_description(description: str) -> str:
    """Condense a JD body into a one-line summary of at most SUMMARY_MAX chars.

    The stored description is raw posting text — HTML fragments, markdown
    bullets and hard wrapping all show up. Collapse it to readable prose and
    skip a leading boilerplate heading so the summary starts on something
    that actually describes the job.
    """
    if not description:
        return ""

    text = re.sub(r"<br\s*/?>|</p>|</li>", " ", description, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)                 # strip stray HTML
    text = re.sub(r"&(nbsp|amp|lt|gt|quot|#39);", " ", text)
    text = re.sub(r"^[\s*_#>\-•]+", " ", text, flags=re.MULTILINE)
    text = re.sub(r"\s+", " ", text).strip()
    text = _BOILERPLATE.sub("", text).strip()
    if not text:
        return ""

    if len(text) <= SUMMARY_MAX:
        return text

    cut = text[:SUMMARY_MAX]
    space = cut.rfind(" ")
    if space > SUMMARY_MAX * 0.6:                        # avoid mid-word cuts
        cut = cut[:space]
    return cut.rstrip(" ,;:.-") + "…"


def transform_job(row: dict) -> dict:
    """Transform Turso row into dashboard-friendly format."""
    score = row.get("match_score")
    if score is None:
        score = 0
    else:
        score = round(float(score))

    # Parse salary notes for suggested ask
    notes = row.get("notes", "") or ""
    suggested_ask = None
    if "ask: $" in notes:
        try:
            ask_part = notes.split("ask: $")[1].split()[0].replace(",", "")
            suggested_ask = int(float(ask_part))
        except (ValueError, IndexError):
            pass

    # Format salary display
    salary_raw = row.get("salary", "") or ""
    salary_display = salary_raw if salary_raw else None

    # Extract estimated range from notes
    if not salary_display and "estimated:" in notes:
        try:
            est_part = notes.split("estimated: $")[1].split("|")[0].strip()
            salary_display = est_part
        except (ValueError, IndexError):
            pass

    # Summary: prefer the real JD body, fall back to the 'Summary:' fragment
    # in notes. The notes path only ever fires on rows captured before the
    # description column existed — it was the sole source before, which is
    # why every row shipped with an empty summary.
    description = (row.get("description") or "").strip()
    # A description that is just the title, or too short to be a posting
    # body, is not a description — do not let it become the summary.
    if len(description) < MIN_DESCRIPTION_CHARS or is_title_only(
        description, row.get("title", "")
    ):
        description = ""
    summary = summarize_description(description) or extract_summary(notes)

    # has_materials: a job has generated materials once it reached
    # 'materials_ready' or has already been applied (C3).
    status = row.get("status", "found")
    has_materials = status in ("materials_ready", "applied")

    return {
        "id": row.get("id"),
        "title": row.get("title", "Unknown"),
        "company": row.get("company", "Unknown"),
        "location": row.get("location", ""),
        "url": row.get("url", ""),
        "salary": salary_display,
        "suggested_ask": suggested_ask,
        "score": score,
        "track": row.get("track", "other"),
        "status": status,
        "source": row.get("source", ""),
        "has_materials": has_materials,
        # jobs.json ships the excerpt only, never the full JD body. At ~6.6K
        # rows the full text would add tens of MB to a file the browser
        # downloads whole, and payload splitting is deliberately deferred.
        # The full description stays in Turso, where /api/generate reads it.
        "description": summary,
        "summary": summary,
        "has_description": bool(description),
        "posted_date": row.get("found_at", ""),
        "found_at": row.get("found_at", ""),
    }


# ── Git operations ───────────────────────────────────────────────────────────
def git_push(repo_path: Path, message: str) -> bool:
    """Pull, commit only jobs.json, then push to main AND master.

    The Pi clone is also a working repository. Never sweep unrelated staged,
    modified, or untracked files into the automated daily data commit.
    """
    try:
        # jobs.json was written immediately before this call. Refuse to touch a
        # worktree with any *other* tracked changes; untracked user files are
        # intentionally ignored and left alone.
        status = subprocess.run(
            [
                "git", "-C", str(repo_path), "status", "--porcelain",
                "--untracked-files=no",
            ],
            capture_output=True, text=True, timeout=30, check=True,
        )
        unrelated = [
            line for line in status.stdout.splitlines()
            if not line.endswith(" data/jobs.json")
        ]
        if unrelated:
            print(
                "[sync] Refusing automated commit: unrelated tracked changes "
                "are present:\n" + "\n".join(f"  {line}" for line in unrelated),
                file=sys.stderr,
            )
            return False

        # Pull --rebase first to avoid divergence (another machine may have
        # pushed changes). --autostash carries the freshly written jobs.json
        # across the pull without including untracked files.
        pull = subprocess.run(
            [
                "git", "-C", str(repo_path), "pull", "--rebase", "--autostash",
                "origin", "main",
            ],
            capture_output=True, text=True, timeout=60,
        )
        if pull.returncode != 0:
            print(f"[sync] Git pull --rebase output: {pull.stdout[:200]}")
            print(f"[sync] Git pull --rebase errors: {pull.stderr[:200]}")
            print("[sync] Stopping before commit because the pull failed.", file=sys.stderr)
            return False

        unmerged = subprocess.run(
            [
                "git", "-C", str(repo_path), "diff", "--name-only",
                "--diff-filter=U", "--", "data/jobs.json",
            ],
            capture_output=True, text=True, timeout=30, check=True,
        )
        if unmerged.stdout.strip():
            print(
                "[sync] jobs.json conflicted while applying the pull autostash; "
                "resolve it manually before syncing again.",
                file=sys.stderr,
            )
            return False

        subprocess.run(
            ["git", "-C", str(repo_path), "add", "--", "data/jobs.json"],
            capture_output=True, text=True, timeout=30, check=True,
        )
        changed = subprocess.run(
            [
                "git", "-C", str(repo_path), "diff", "--cached", "--quiet",
                "--", "data/jobs.json",
            ],
            capture_output=True, text=True, timeout=30,
        )
        if changed.returncode == 1:
            commit = subprocess.run(
                [
                    "git", "-C", str(repo_path), "commit", "--only", "-m",
                    message, "--", "data/jobs.json",
                ],
                capture_output=True, text=True, timeout=30,
            )
            if commit.returncode != 0:
                print(f"[sync] Git commit output: {commit.stdout[:200]}")
                print(f"[sync] Git commit errors: {commit.stderr[:200]}")
                return False
        elif changed.returncode == 0:
            print("[sync] data/jobs.json is unchanged; no commit needed")
        else:
            print("[sync] Could not inspect the staged jobs.json change", file=sys.stderr)
            return False

        r1 = subprocess.run(["git", "-C", str(repo_path), "push", "origin", "main"],
                            capture_output=True, text=True, timeout=60)
        r2 = subprocess.run(["git", "-C", str(repo_path), "push", "origin", "main:master"],
                            capture_output=True, text=True, timeout=60)
        if r1.returncode == 0 and r2.returncode == 0:
            print(f"[sync] Git push to main + master successful")
            return True
        else:
            print(f"[sync] Git push main output: {r1.stdout[:200]}")
            print(f"[sync] Git push main errors: {r1.stderr[:200]}")
            print(f"[sync] Git push master output: {r2.stdout[:200]}")
            print(f"[sync] Git push master errors: {r2.stderr[:200]}")
            return False
    except subprocess.TimeoutExpired:
        print("[sync] Git push timed out", file=sys.stderr)
        return False
    except Exception as e:
        print(f"[sync] Git error: {e}", file=sys.stderr)
        return False


# ── Main ─────────────────────────────────────────────────────────────────────
def main() -> int:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # 1. Fetch jobs
    print(f"[sync] Fetching jobs from Turso...")
    rows = fetch_all_jobs()
    print(f"[sync] {len(rows)} active jobs found")

    if not rows:
        print("[sync] No jobs to sync")
        return 0

    # 2. Transform
    jobs = [transform_job(r) for r in rows]

    # 3. Ensure repo exists
    if not DASHBOARD_REPO_PATH.exists():
        print(f"[sync] Repo not found at {DASHBOARD_REPO_PATH}. Skipping git push.")
        print(f"[sync] Outputting jobs.json to stdout for manual sync:")
        print(json.dumps({"jobs": jobs, "meta": {"updated": today, "count": len(jobs)}}, indent=2))
        return 1

    # 4. Write jobs.json
    DASHBOARD_DATA_DIR.mkdir(parents=True, exist_ok=True)
    output = {
        "meta": {
            "updated": today,
            "count": len(jobs),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
        "jobs": jobs,
    }
    DASHBOARD_REPO_PATH.joinpath("data/jobs.json").write_text(
        json.dumps(output, indent=2)
    )
    print(f"[sync] Written to {DASHBOARD_JOBS_JSON} ({len(jobs)} jobs)")

    # 5. Git push
    commit_msg = f"chore: daily job data update for {today}"
    if git_push(DASHBOARD_REPO_PATH, commit_msg):
        print(f"[sync] ✅ Dashboard updated and deployed")
        return 0
    else:
        print(f"[sync] ⚠️  Data written but git push had issues")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
