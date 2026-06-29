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
def fetch_all_jobs() -> list:
    """Fetch all non-archived jobs, sorted by match_score DESC."""
    rows = turso_query(
        "SELECT id, source, external_id, company, title, location, url, "
        "salary, match_score, track, status, notes, found_at "
        "FROM applications "
        "WHERE status IN ('found', 'materials_ready', 'applied', 'saved') "
        "ORDER BY match_score DESC"
    )
    return rows


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

    # Extract summary from notes (W10 — properly parse the 'Summary:' fragment)
    summary = extract_summary(notes)

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
        "description": summary,
        "summary": summary,
        "posted_date": row.get("found_at", ""),
        "found_at": row.get("found_at", ""),
    }


# ── Git operations ───────────────────────────────────────────────────────────
def git_push(repo_path: Path, message: str) -> bool:
    """Pull rebase, commit, then push to main AND master."""
    try:
        # Pull --rebase first to avoid divergence (Mac may have pushed changes)
        pull = subprocess.run(
            ["git", "-C", str(repo_path), "pull", "--rebase", "origin", "main"],
            capture_output=True, timeout=60,
        )
        if pull.returncode != 0:
            print(f"[sync] Git pull --rebase output: {pull.stdout[:200]}")
            print(f"[sync] Git pull --rebase errors: {pull.stderr[:200]}")
            print("[sync] Continuing despite pull issue...")

        subprocess.run(["git", "-C", str(repo_path), "add", "-A"],
                       capture_output=True, timeout=30, check=True)
        subprocess.run(["git", "-C", str(repo_path), "commit", "-m", message],
                       capture_output=True, timeout=30)
        r1 = subprocess.run(["git", "-C", str(repo_path), "push", "origin", "main"],
                            capture_output=True, timeout=60)
        r2 = subprocess.run(["git", "-C", str(repo_path), "push", "origin", "main:master"],
                            capture_output=True, timeout=60)
        if r1.returncode == 0 or r2.returncode == 0:
            print(f"[sync] Git push to main + master successful")
            return True
        else:
            print(f"[sync] Git push output: {r2.stdout[:200]}")
            print(f"[sync] Git push errors: {r2.stderr[:200]}")
            return False
    except subprocess.TimeoutExpired:
        print("[sync] Git push timed out", file=sys.stderr)
        return False
    except Exception as e:
        print(f"[sync] Git error: {e}", file=sys.stderr)
        return False


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # 1. Fetch jobs
    print(f"[sync] Fetching jobs from Turso...")
    rows = fetch_all_jobs()
    print(f"[sync] {len(rows)} active jobs found")

    if not rows:
        print("[sync] No jobs to sync")
        return

    # 2. Transform
    jobs = [transform_job(r) for r in rows]

    # 3. Ensure repo exists
    if not DASHBOARD_REPO_PATH.exists():
        print(f"[sync] Repo not found at {DASHBOARD_REPO_PATH}. Skipping git push.")
        print(f"[sync] Outputting jobs.json to stdout for manual sync:")
        print(json.dumps({"jobs": jobs, "meta": {"updated": today, "count": len(jobs)}}, indent=2))
        return

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
    else:
        print(f"[sync] ⚠️  Data written but git push had issues")


if __name__ == "__main__":
    main()
