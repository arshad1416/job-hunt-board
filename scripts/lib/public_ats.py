#!/usr/bin/env python3
"""
public_ats.py — Public ATS job-board ingestion for the job-hunt pipeline.

Queries the DOCUMENTED public job-board JSON APIs of Greenhouse, Lever and
Ashby for a CONFIGURED allowlist of employer slugs only. There is no search
endpoint here and no arbitrary-URL entry point: the request target is always
built from "provider:slug" pairs, and slugs are strictly validated.

Design constraints (deliberate):
- stdlib only (urllib, json, re, html) — runs on the Pi with no venv.
- Every function is pure except fetch_board(); planning and parsing are fully
  unit-testable without network.
- Failures are returned, never raised: a dead board must not kill the 9AM
  cron. Callers turn the error into source-health counters.

Opt-in configuration (absent by default — no behavior change):
  env   ATS_PROVIDERS="greenhouse:tesla,lever:zeekr,ashby:stripe"
  or    resume_profile.yaml:
          ats_boards:
            - {provider: greenhouse, slug: tesla, label: Tesla}
  Only the three providers in PROVIDERS are accepted; anything else is
  skipped with a warning rather than guessed at.
"""

import base64
import binascii
import json
import os
import re
import html
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

PROVIDERS = ("greenhouse", "lever", "ashby")

# Slug allowlist shape: employer board tokens are short, lowercase, and never
# contain path syntax, query syntax, whitespace, or a scheme. This is the
# whole reason "no arbitrary URLs" is enforceable.
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,62}$")

# Boards are re-scanned daily and de-duplicated downstream; a posting older
# than this is noise even for a target employer.
DEFAULT_MAX_AGE_DAYS = 45

_USER_AGENT = "job-hunt-board-pipeline/1.0 (public-ats; +local)"


def parse_provider_config(raw):
    """Parse 'greenhouse:tesla,lever:zeekr' or a JSON list into board specs.

    Returns (boards, warnings). Each board is
    {"provider": str, "slug": str, "label": str}. Invalid entries are dropped
    and explained in warnings — never silently, never fatally.
    """
    raw = (raw or "").strip()
    if not raw:
        return [], []

    entries = []
    warnings = []
    if raw.startswith("["):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            return [], [f"ATS_PROVIDERS JSON unreadable: {e}"]
        if not isinstance(data, list):
            return [], ["ATS_PROVIDERS JSON must be a list"]
        for item in data:
            if isinstance(item, str):
                entries.append(item)
            elif isinstance(item, dict):
                entries.append({
                    "provider": item.get("provider", ""),
                    "slug": item.get("slug", ""),
                    "label": item.get("label", ""),
                })
    else:
        entries = [e.strip() for e in raw.split(",")]

    seen = set()
    boards = []
    for entry in entries:
        if isinstance(entry, dict):
            provider = str(entry.get("provider", "")).strip().lower()
            slug = str(entry.get("slug", "")).strip().lower()
            label = str(entry.get("label", "") or "").strip()
        else:
            parts = [p.strip() for p in str(entry).split(":", 2) if p.strip()]
            if len(parts) < 2:
                warnings.append(f"malformed board spec skipped: {entry!r} (want provider:slug)")
                continue
            provider, slug = parts[0].lower(), parts[1].lower()
            label = parts[2] if len(parts) > 2 else ""
        label = label or slug.replace("-", " ").replace("_", " ").title()
        if provider not in PROVIDERS:
            warnings.append(f"unsupported provider skipped: {provider!r} (allowed: {', '.join(PROVIDERS)})")
            continue
        if not _SLUG_RE.match(slug):
            warnings.append(f"invalid slug skipped: {slug!r}")
            continue
        key = (provider, slug)
        if key in seen:
            continue
        seen.add(key)
        boards.append({"provider": provider, "slug": slug, "label": label})
    return boards, warnings


def boards_from_profile(profile):
    """Read the optional resume_profile.yaml 'ats_boards' section.

    Accepts dicts ({provider, slug, label}) or 'provider:slug' strings and
    routes them through the same validation as the env var.
    """
    section = (profile or {}).get("ats_boards") or []
    if not isinstance(section, list):
        return [], [f"ats_boards must be a list, got {type(section).__name__}"]
    rendered = []
    for item in section:
        if isinstance(item, dict):
            rendered.append({
                "provider": item.get("provider", ""),
                "slug": item.get("slug", ""),
                "label": item.get("label", ""),
            })
        else:
            rendered.append(str(item))
    return parse_provider_config(json.dumps(rendered))


def configured_boards(profile=None):
    """Env first, profile second — env wins so the cron can override without
    touching the resume profile. Returns (boards, warnings)."""
    env_raw = os.environ.get("ATS_PROVIDERS", "")
    if env_raw.strip():
        return parse_provider_config(env_raw)
    return boards_from_profile(profile)


def board_api_url(provider, slug):
    """The documented public board endpoint for a validated provider:slug.

    Returns '' for anything that fails validation — this function is the
    'no arbitrary URLs' enforcement point.
    """
    provider = (provider or "").lower()
    slug = (slug or "").lower()
    if provider not in PROVIDERS or not _SLUG_RE.match(slug):
        return ""
    if provider == "greenhouse":
        return f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
    if provider == "lever":
        return f"https://api.lever.co/v0/postings/{slug}?mode=json"
    return f"https://api.ashbyhq.com/posting-api/job-board/{slug}"


_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t\r\f\v]+")


def html_to_text(fragment):
    """Minimal HTML-to-text for Greenhouse/Lever/Ashby bodies (no deps)."""
    if not fragment:
        return ""
    if isinstance(fragment, str):
        try:
            decoded_bytes = base64.b64decode(fragment, validate=True)
            decoded = decoded_bytes.decode("utf-8")
            # Greenhouse returns base64 HTML; only replace input when the
            # decoded payload actually looks like markup.
            if re.search(r"<[^>]+>", decoded):
                fragment = decoded
        except (ValueError, binascii.Error, UnicodeDecodeError):
            pass
    text = re.sub(r"(?i)<(br|/p|/li|/div|/h[1-6])[^>]*>", "\n", fragment)
    text = _TAG_RE.sub(" ", text)
    text = html.unescape(text).replace("\u00a0", " ")
    lines = [_WS_RE.sub(" ", line).strip() for line in text.split("\n")]
    out = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip()


def _iso_from_epoch(ms):
    if not ms:
        return ""
    try:
        return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError):
        return ""


def _job(provider, slug, label, *, ext_id, title, location, url, description,
         created_at="", remote=False, updated_at=""):
    return {
        "id": f"{provider}-{ext_id}" if ext_id else "",
        "title": (title or "").strip(),
        "company": label,
        "location": (location or "").strip(),
        "job_url": (url or "").strip(),
        "description": (description or "").strip(),
        "is_remote": bool(remote),
        "site": f"ats-{provider}",
        "_provider": provider,
        "_board_slug": slug,
        "_created_at": created_at,
        "_updated_at": updated_at,
    }


def parse_greenhouse(payload, slug, label=None):
    """boards-api.greenhouse.io/v1/boards/{b}/jobs?content=true -> jobs."""
    label = label or slug.replace("-", " ").title()
    jobs = []
    for posting in (payload or {}).get("jobs") or []:
        title = (posting or {}).get("title") or ""
        if not title:
            continue
        meta = (posting or {}).get("metadata") or []
        updated = ""
        if isinstance(meta, list):
            for kv in meta:
                if isinstance(kv, dict) and kv.get("name") == "updated_at":
                    updated = str(kv.get("value") or "")
        jobs.append(_job(
            "greenhouse", slug, label,
            ext_id=str(posting.get("id") or ""),
            title=title,
            location=(posting.get("location") or {}).get("name", ""),
            url=posting.get("absolute_url") or "",
            description=html_to_text(posting.get("content") or ""),
            updated_at=updated,
        ))
    return jobs


def parse_lever(payload, slug, label=None):
    """api.lever.co/v0/postings/{c}?mode=json -> jobs."""
    label = label or slug.replace("-", " ").title()
    jobs = []
    for posting in (payload or {}).get("data") or []:
        title = (posting or {}).get("text") or ""
        if not title:
            continue
        cats = (posting or {}).get("categories") or {}
        jobs.append(_job(
            "lever", slug, label,
            ext_id=str(posting.get("id") or ""),
            title=title,
            location=cats.get("location") or (posting.get("workplaceType") or ""),
            url=posting.get("hostedUrl") or "",
            description=html_to_text(posting.get("descriptionPlain") or ""),
            created_at=_iso_from_epoch(posting.get("createdAt")),
            remote=(posting.get("workplaceType") or "").lower() == "remote",
        ))
    return jobs


def parse_ashby(payload, slug, label=None):
    """api.ashbyhq.com/posting-api/job-board/{org} -> jobs."""
    label = label or slug.replace("-", " ").title()
    jobs = []
    for posting in (payload or {}).get("jobs") or []:
        title = (posting or {}).get("title") or ""
        if not title:
            continue
        jobs.append(_job(
            "ashby", slug, label,
            ext_id=str(posting.get("id") or ""),
            title=title,
            location=posting.get("location") or "",
            url=posting.get("jobUrl") or "",
            description=html_to_text(posting.get("descriptionPlain") or ""),
            created_at=str(posting.get("publishedAt") or ""),
            remote=bool(posting.get("isRemote")),
        ))
    return jobs


PARSERS = {
    "greenhouse": parse_greenhouse,
    "lever": parse_lever,
    "ashby": parse_ashby,
}


def is_stale(created_at, now=None, max_age_days=DEFAULT_MAX_AGE_DAYS):
    """True when a posting is older than the scan window (or unparseable-
    fresh). Postings with NO date are kept — absence is not evidence."""
    if not created_at:
        return False
    now = now or datetime.now(timezone.utc)
    try:
        stamp = str(created_at).replace("Z", "+00:00")
        dt = datetime.fromisoformat(stamp)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return dt < now - timedelta(days=max_age_days)


def fetch_board(provider, slug, label=None, *, timeout=20, urlopen=urllib.request.urlopen):
    """Fetch one board. Returns (jobs, error) — error is None on success.

    urlopen is injectable so tests never touch the network.
    """
    url = board_api_url(provider, slug)
    if not url:
        return [], f"unusable board spec: {provider}:{slug}"
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": _USER_AGENT,
            "Accept": "application/json",
        })
        with urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        return [], f"HTTP {e.code} from {provider}:{slug}"
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return [], f"network error from {provider}:{slug}: {e}"
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        return [], f"bad JSON from {provider}:{slug}: {e}"

    parser = PARSERS[provider]
    try:
        return parser(payload, slug, label), None
    except (AttributeError, KeyError, TypeError) as e:
        return [], f"parse error from {provider}:{slug}: {e}"


def fetch_all_boards(boards, *, timeout=20, urlopen=urllib.request.urlopen,
                     now=None, max_age_days=DEFAULT_MAX_AGE_DAYS):
    """Fetch every configured board, applying the freshness window.

    Returns (jobs, health) where health maps provider:slug to
    {"ok": bool, "jobs": int, "error": str} — the source-health counters the
    scraper merges into its log.
    """
    jobs = []
    health = {}
    now = now or datetime.now(timezone.utc)
    for board in boards:
        provider, slug = board["provider"], board["slug"]
        key = f"{provider}:{slug}"
        fetched, error = fetch_board(
            provider, slug, board.get("label"), timeout=timeout, urlopen=urlopen,
        )
        fresh = [j for j in fetched if not is_stale(j.get("_created_at"), now, max_age_days)]
        health[key] = {
            "ok": error is None,
            "jobs": len(fresh),
            "dropped_stale": len(fetched) - len(fresh),
            "error": error or "",
        }
        jobs.extend(fresh)
    return jobs, health
