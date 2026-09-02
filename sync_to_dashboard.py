#!/usr/bin/env python3
"""
sync_to_dashboard.py — Runs after job_hunt_daily.py on Pi.

1. Reads all active lifecycle jobs from Turso
2. Generates data/jobs.json for the dashboard
3. Git commits + pushes to trigger Cloudflare Pages deploy

Run: python3 ~/.hermes/scripts/sync_to_dashboard.py
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone, date, timedelta
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
ACTIVE_STATUSES = "('found', 'materials_ready', 'applied', 'saved', 'screening', 'interview', 'offer', 'rejected', 'ghosted')"


# Columns added by later additive migrations. The 9AM cron must not
# fail because one of them is missing. Query each column independently so
# migration 001 and 002 can be deployed in either order.
OPTIONAL_COLUMNS = (
    "description",                                           # 001
    "follow_up_due", "urgency", "is_repost", "gate", "applied_at",  # 002
)


def _is_missing_optional_column(error: Exception) -> bool:
    """Only schema-missing errors may degrade an optional projection."""
    text = str(error).lower()
    return any(token in text for token in ("no such column", "unknown column", "does not exist"))


def fetch_all_jobs() -> list:
    """Fetch all non-archived jobs, retaining every optional column present."""
    tail = (
        f"FROM applications "
        f"WHERE status IN {ACTIVE_STATUSES} "
        f"ORDER BY match_score DESC"
    )
    selected = []
    for column in OPTIONAL_COLUMNS:
        try:
            candidate = ', '.join([BASE_COLUMNS, *selected, column])
            turso_query(f"SELECT {candidate} {tail}")
            selected.append(column)
        except Exception as e:
            if not _is_missing_optional_column(e):
                raise
            print(
                f"[sync] optional column unavailable ({column!r}: {e}); "
                f"continuing without it",
                file=sys.stderr,
            )
    # Probe calls above discover availability; this final call is the only
    # result returned to the caller, avoiding a partially mixed row set.
    return turso_query(f"SELECT {', '.join([BASE_COLUMNS, *selected])} {tail}")


# ── URL normalization / dedup (board-level) ──────────────────────────────────
# The Pi-side scraper dedupes on external_id and company|title|city before
# insert, but re-listings under a new id with a reworded title still slip
# through. Normalize the posting URL itself so the same employer listing
# behind different board wrappers collapses at sync time.

_TRACKING_PARAM_RE = re.compile(
    r"^(?:utm_|rx_)|^(?:source|ref|referral|gh_src|gh_jid|trk|skov|"
    r"li_fat_id|fbclid|gclid|mc_cid|mc_eid|s|cmpid|jobaggregator)$",
    re.I,
)


def normalize_url_key(url: str) -> str:
    """Stable identity for a posting URL, '' when there is nothing to key.

    Lowercases the scheme/host, strips tracking parameters, sorts the rest,
    and drops a trailing slash on an empty path. Never resolves redirects —
    this must stay a pure string operation.
    """
    raw = (url or "").strip()
    if not raw:
        return ""
    m = re.match(r"^(https?)://([^/?#]+)([^#]*)(?:#(.*))?$", raw, re.I)
    if not m:
        return ""
    scheme = "https"                     # http/https are the same posting
    host = m.group(2).lower()
    host = host.split("@")[-1]           # strip userinfo if any
    host = host.rstrip(".")
    path_query = m.group(3)
    path, _, query = path_query.partition("?")
    query = query.split("#", 1)[0]

    keep = []
    for pair in query.split("&"):
        if not pair:
            continue
        key = pair.split("=", 1)[0]
        if _TRACKING_PARAM_RE.match(key):
            continue
        keep.append(pair)
    keep.sort()

    path = path.rstrip("/") or ""
    out = f"{scheme}://{host}{path}"
    if keep:
        out += "?" + "&".join(keep)
    return out


# ── Application-deadline extraction ──────────────────────────────────────────
_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}

# Only trust a date when deadline language sits in the same fragment, so a
# random date in the benefits section is never read as a closing date.
_DEADLINE_KEYWORD_RE = re.compile(
    r"(?:apply by|applications? (?:close|closed|due)|closing date|"
    r"deadline|posting closes?|open until|will remain open until|"
    r"submission deadline)\s*[:\-]?\s*([^.|\n]{0,60})",
    re.I,
)

_TEXT_MONTH = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
_ISO_DATE_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_TEXT_DATE_RE = re.compile(
    rf"\b({_TEXT_MONTH}\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s*(\d{{4}})?)\b"
    rf"|\b((\d{{1,2}})(?:st|nd|rd|th)?\s+{_TEXT_MONTH}\s*(\d{{4}})?)\b",
    re.I,
)
_SLASH_DATE_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b")


def _parse_deadline_fragment(fragment: str, today):
    """Best-effort date out of the text right after deadline language."""
    frag = fragment.strip()
    m = _ISO_DATE_RE.search(frag)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = _SLASH_DATE_RE.search(frag)
    if m:
        # North-American convention (MM/DD) matches this board's geography.
        mm, dd = int(m.group(1)), int(m.group(2))
        try:
            return date(int(m.group(3)), mm, dd)
        except ValueError:
            return date(int(m.group(3)), dd, mm)
    m = _TEXT_DATE_RE.search(frag)
    if m:
        if m.group(1):
            first_word = m.group(1).split(".")[0].split()[0].rstrip(".,")
            month = _MONTHS.get(first_word.lower())
            day, year = int(m.group(2)), m.group(3)
        else:
            day = int(m.group(5))
            second = m.group(4).split()[1].rstrip(".,")
            month = _MONTHS.get(second.lower())
            year = m.group(6)
        if month:
            try:
                if year:
                    return date(int(year), month, day)
                parsed = date(today.year, month, day)
            except ValueError:
                return None
            if parsed < today:  # no year given: assume a future cycle
                parsed = parsed.replace(year=today.year + 1)
            return parsed
    return None


def extract_deadline(text: str, today=None) -> str:
    """ISO closing date parsed from posting text, '' when none is stated."""
    if not text:
        return ""
    today = today or date.today()
    for m in _DEADLINE_KEYWORD_RE.finditer(text):
        parsed = _parse_deadline_fragment(m.group(1), today)
        if parsed:
            return parsed.isoformat()
    return ""


def deadline_status(deadline: str, today=None) -> str:
    """'expired' | 'closing_soon' | 'open' | '' (no deadline known)."""
    if not deadline:
        return ""
    today = today or date.today()
    try:
        d = date.fromisoformat(deadline)
    except ValueError:
        return ""
    if d < today:
        return "expired"
    if d <= today + timedelta(days=7):
        return "closing_soon"
    return "open"


def dedupe_jobs(jobs: list):
    """Drop later rows whose normalized URL key was already seen.

    Rows without a usable URL key are always kept — dedup only ever fires on
    positive URL identity, never on a missing one.
    """
    seen = set()
    kept = []
    dropped = 0
    for job in jobs:
        key = job.get("url_key") or ""
        if key and key in seen:
            dropped += 1
            continue
        if key:
            seen.add(key)
        kept.append(job)
    return kept, dropped


# ── Source-health sentinel ───────────────────────────────────────────────────
# Sources the pipeline is configured to run daily. A configured source with
# zero active rows, or any single source holding >90% of the board, is a
# silent-scrape-failure smell worth shouting about in the cron log.
EXPECTED_SOURCES = ("indeed", "linkedin", "adzuna")
SINGLE_SOURCE_SHARE_ALERT = 0.90


def compute_source_health(jobs: list, today: str = "") -> dict:
    counts = {}
    last_seen = {}
    for job in jobs:
        src = (job.get("source") or "unknown").lower()
        counts[src] = counts.get(src, 0) + 1
        seen = job.get("found_at") or ""
        if seen and seen > last_seen.get(src, ""):
            last_seen[src] = seen

    sources = {
        name: {
            "active_rows": counts.get(name, 0),
            "last_found_at": last_seen.get(name, ""),
        }
        for name in sorted(set(counts) | set(EXPECTED_SOURCES))
    }
    total = len(jobs)
    warnings = [
        f"{name}: 0 active rows (source may be silently failing)"
        for name in EXPECTED_SOURCES if counts.get(name, 0) == 0
    ]
    if total and len(counts) > 1:
        hot = max(counts.items(), key=lambda kv: kv[1])
        if hot[1] / total > SINGLE_SOURCE_SHARE_ALERT:
            warnings.append(f"{hot[0]} holds {hot[1]}/{total} active rows (>90%)")
    return {
        "updated": today or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "total_active": total,
        "sources": sources,
        "warnings": warnings,
    }


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
MIN_DESCRIPTION_CHARS = 40


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


def transform_job(row: dict, today=None) -> dict:
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
    # 'materials_ready' or any later pipeline status (C3). The extended
    # statuses (screening/interview/offer/rejected/ghosted) all imply the
    # candidate applied, and therefore had materials generated.
    status = row.get("status", "found")
    has_materials = status in (
        "materials_ready", "applied", "screening", "interview",
        "offer", "rejected", "ghosted",
    )

    # Indicator + follow-up fields from migration 002. Missing columns
    # (pre-migration databases) yield None and are normalized away so
    # old jobs.json consumers see exactly the keys they saw before plus
    # these new, nullable ones.
    is_repost = row.get("is_repost")
    follow_up_due = row.get("follow_up_due") or ""
    urgency = (row.get("urgency") or "").strip()
    gate = (row.get("gate") or "").strip()

    # Board-level dedup identity and application-deadline bookkeeping. The
    # deadline scan runs on the usable body, then notes when the body is a
    # title-only/short placeholder; the 200-char summary cut drops exactly
    # the tail where a closing line can live.
    url_key = normalize_url_key(row.get("url", ""))
    deadline = extract_deadline(description or notes)

    return {
        "url_key": url_key,
        "deadline": deadline,
        "deadline_status": deadline_status(deadline, today),
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
        # ── portal subset (migration 002) ──
        "applied_at": row.get("applied_at") or "",
        "follow_up_due": follow_up_due,
        "urgency": urgency,
        "is_repost": bool(is_repost),
        "gate": gate,
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

        # master must only ever receive fast-forwards from main. If it holds
        # commits main lacks (e.g. a PR was merged directly into master), the
        # promotion push will be rejected — surface that explicitly instead
        # of a generic git error, so stale dashboard data is diagnosed the
        # same day it happens.
        fetch_master = subprocess.run(
            ["git", "-C", str(repo_path), "fetch", "origin", "master"],
            capture_output=True, text=True, timeout=60,
        )
        ff_check = subprocess.run(
            ["git", "-C", str(repo_path), "merge-base", "--is-ancestor",
             "origin/master", "main"],
            capture_output=True, text=True, timeout=30,
        )
        if fetch_master.returncode != 0 or ff_check.returncode != 0:
            print(
                "[sync] master has commits main lacks (or could not be "
                "fetched) — merge master into main manually before the next "
                "sync, or the dashboard data will stay stale.",
                file=sys.stderr,
            )
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

    # An empty result is still a real sync result: publish it rather than
    # leaving yesterday's board silently live.
    today_date = date.fromisoformat(today)
    jobs = [transform_job(r, today_date) for r in rows]

    # 2b. Expiry sweep: a posting whose stated application deadline has
    # passed is dead even if the board page still resolves. Dropping it here
    # keeps the board honest between liveness passes.
    expiry_statuses = {"found", "materials_ready", "saved"}
    expired = [j for j in jobs if j.get("deadline_status") == "expired"
               and j.get("status", "found") in expiry_statuses]
    if expired:
        print(f"[sync] Expiry sweep: dropping {len(expired)} past-deadline postings: "
              + ", ".join(f"{j['company']} ({j['deadline']})" for j in expired[:5]))
        expired_ids = {j.get("id") for j in expired}
        jobs = [j for j in jobs if j.get("id") not in expired_ids]

    # 2c. URL-key dedup (same listing behind different board wrappers).
    jobs, url_dupes = dedupe_jobs(jobs)
    if url_dupes:
        print(f"[sync] URL-key dedup dropped {url_dupes} duplicate rows")

    # 2d. Source-health sentinel for the cron log.
    health = compute_source_health(jobs, today)
    for warning in health["warnings"]:
        print(f"[sync] ⚠️  SOURCE HEALTH: {warning}", file=sys.stderr)

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

    # Sentinel file for the Pi cron: stays local (the git push deliberately
    # commits only jobs.json), so it never widens the automated commit.
    DASHBOARD_REPO_PATH.joinpath("data/source-health.json").write_text(
        json.dumps(health, indent=2)
    )

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
