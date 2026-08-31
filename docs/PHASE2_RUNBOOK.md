# Phase 2 Runbook — descriptions + liveness

Everything in this repo for Phase 2 is code. The steps that touch **live
Turso** or the **Pi pipeline** are here, for you to run, in order.

Nothing below runs automatically. Every script that writes is **dry-run by
default** and needs an explicit `--commit` or `--confirm`.

**Ground rules carried through all of it**

- Back up `applications` before any DDL. The migration is additive only.
- Test liveness and backfill on **≤50 rows** before any full run.
- No full re-scrape. Liveness re-checks URLs you already have, one at a
  time, with a jittered 5–10s per-host delay.
- The 9AM ET cron must survive every step. §1, §2 and §5 are each written
  so the cron still completes if you stop there.

---

## Operations: renderer health and recovery

The Pi renderer runs from a timer invoking `node scripts/render-jobs.mjs --limit 10`; it is dry-run by default. Generate an offline report with `node scripts/health-report.mjs --self-test` or `node scripts/health-report.mjs --input report.json`; input is capped at 1000 rows and output contains counters only. The report reads existing `applications`, `material_versions`, and `render_jobs` tables; there is no `generation_jobs` table. Use `--execute` only after `node scripts/health-report.mjs` and a small canary. The shared lock prevents overlap; retries are bounded to three attempts with backoff, and failed output never replaces a successful version. Rollback restores a prior immutable version pointer, followed by a manifest/download check. Retention is intentionally non-destructive: never delete the current version; only consider cleanup after versioned artifacts are live and a restore test proves the current version survives. Interview, offer, salary, and richer follow-up remain future proposals.

```bash
node scripts/health-report.mjs --self-test
node scripts/render-jobs.mjs --dry-run --limit 10
```

---

## 0. Prerequisites

On the Pi:

```bash
node --version          # need 18+ for global fetch
turso --version

export TURSO_URL="https://morning-briefing-arshad1416.aws-us-east-1.turso.io"
export TURSO_TOKEN="$(turso db tokens create morning-briefing)"

cd ~/job-hunt-board
git fetch origin && git checkout claude/job-hunt-security-pipeline-p7f9oy
```

`TURSO_TOKEN` stays in your shell. Do not write it into any file in this
repo — `.env` and `.dev.vars` are gitignored and nothing here reads them.

---

## 1. Back up `applications`

Do this even though the migration is additive.

```bash
cd ~
turso db shell morning-briefing ".dump" > applications-backup-$(date +%F).sql

# Verify the dump is real before trusting it
ls -lh applications-backup-$(date +%F).sql
grep -c 'INSERT INTO applications' applications-backup-$(date +%F).sql
```

The row count in the dump should be in the same ballpark as
`SELECT COUNT(*) FROM applications`. If the grep returns 0, **stop** — the
dump did not capture the table and the rest of this runbook is unsafe.

---

## 2. Apply the additive migration

The column the whole phase hangs on:

```sql
ALTER TABLE applications ADD COLUMN description TEXT;
```

Inspect first — this writes nothing:

```bash
cd ~/job-hunt-board
node scripts/add-description-column.mjs
```

Then apply:

```bash
node scripts/add-description-column.mjs --confirm
```

The script checks `PRAGMA table_info` first, so re-running is a no-op rather
than a `duplicate column name` error. It re-counts rows after the `ALTER`
and fails loudly if the count moved.

**Cron safety at this point:** `sync_to_dashboard.py` on the Pi is still the
old copy, which never mentions `description`. An added, unused, all-NULL
column is invisible to it. The 9AM run is unaffected whether or not you
continue.

---

## 3. Capture descriptions on the next scrape ← *the actual fix*

> ### ⚠️ Known failure observed on 2026-07-31 — read this first
>
> A first attempt at this step ran and *looked* like it worked: the column
> was populated, 141 rows had non-empty `summary`, and the row count grew
> from 6595 to 6691. But **every populated row held the job title and
> nothing else** — `summary` was exactly equal to `title` on 141 of 141
> rows, mean length 32 chars, none longer than 85.
>
> That is this project's original bug wearing a disguise. Resumes were
> still being generated from titles alone; the column just made it look
> fixed.
>
> **Cause:** `job_hunt_daily.py` bound the title into the `description`
> column — either the wrong variable in the args tuple, or jobspy returned
> no description (because `description_format` was never requested) and a
> fallback like `job.get("description") or job.get("title")` filled it in.
>
> **Check for it directly:**
> ```bash
> turso db shell morning-briefing \
>   "SELECT COUNT(*) AS populated,
>           SUM(CASE WHEN lower(trim(description))=lower(trim(title))
>                    THEN 1 ELSE 0 END) AS title_only,
>           SUM(CASE WHEN length(trim(description))>=200 THEN 1 ELSE 0 END) AS real_bodies
>    FROM applications
>    WHERE description IS NOT NULL AND trim(description) != ''"
> ```
> `title_only` must be ~0 and `real_bodies` must be most of `populated`.
> `verify-goal.mjs` now enforces exactly this, so criterion 3 fails loudly
> instead of passing on headline text. `generate.js` and
> `sync_to_dashboard.py` also treat a title-only description as *absent*,
> so a repeat of this cannot silently degrade a resume.
>
> ### Historical resolution (2026-07-31), superseded 2026-08-01
>
> The Pi session established the real cause, and it is upstream of the
> INSERT: **the scraper never returns JD text at all.** The MCP
> `scrape_jobs` tool emits a plain-text summary (Title/Company/Location/
> URL/Posted) with no description field, even with
> `description_format="markdown"`, so `parse_mcp_text` sets
> `description = title`. `adzuna_scraper.py:124` hardcodes the same. The §3
> patch was applied faithfully and *cannot* do better — no INSERT fix
> conjures text that was never fetched.
>
> Getting real prose at scrape time would need a per-posting `fetch_job`
> call: 140+ extra hits on LinkedIn/Indeed every night, which is exactly
> the rate-limit exposure this project is avoiding.
>
> **So the JD is now fetched lazily in `/api/generate` instead** — one
> request, only for a job you actually clicked Generate on, using the same
> `functions/_lib/extract-jd.mjs` extractor as the backfill script. The
> result is cached back into `description` (guarded so a real body is never
> clobbered), so the next generate is instant and the nightly sync can
> build a real summary from it. Every failure path — anti-bot wall, 404,
> timeout, title-only page — degrades to the "no description captured"
> prompt rather than failing the request.
>
> **What this means for the criteria:** criterion 3 no longer requires
> descriptions to arrive from a scrape, only that real posting bodies
> exist. Criterion 4 (bulk `jobs.json` summaries) stays largely unmet by
> design — summaries appear for jobs you have generated materials for, and
> grow over time, rather than all 6.6K rows at once.
>
> **Before re-running:** confirm jobspy is actually returning description
> text, rather than assuming the INSERT is at fault:
> ```python
> jobs = scrape_jobs(..., description_format="markdown")
> print(jobs[["title"]].head())
> print(jobs["description"].str.len().describe())   # must NOT be all-NaN or tiny
> ```
> If lengths are NaN or near-zero, the problem is the scrape call (3a), not
> the INSERT (3b). Fix that first — no amount of INSERT correction
> conjures text that was never fetched.
>
> **Current implementation:** `scripts/jobspy_json.mjs` calls jobspy's
> structured library API and preserves fields its MCP formatter omitted. New
> Indeed rows therefore arrive with their JD and employer URL without extra
> detail-page requests. LinkedIn detail fetching stays disabled by default;
> missing text is resolved through a recognized public ATS API when possible,
> then by one bounded on-demand HTML fetch. See README “Maintenance Scripts.”


This is the step that satisfies "populated by a real `job_hunt_daily.py`
run". Everything else is repair work.

`job_hunt_daily.py` lives only on the Pi (`~/.hermes/scripts/`) and is not
in this repo, so I could not patch it directly. **The variable names below
are illustrative — match them to what the file actually uses.**

jobspy already returns the description alongside every posting; today it is
being dropped on the floor before the insert. Two changes:

**3a. Ask the scraper for description text.** Find the `scrape_jobs(...)`
call and make sure it requests descriptions:

```python
jobs = scrape_jobs(
    ...,
    description_format="markdown",   # or "html"
)
```

**3b. Carry it into the insert.** Find the `INSERT INTO applications`
statement and add the column and its placeholder:

```python
# before
"INSERT INTO applications (source, external_id, company, title, location, "
"url, salary, match_score, track, status, notes, found_at) "
"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"

# after — one extra column, one extra placeholder, one extra arg
"INSERT INTO applications (source, external_id, company, title, location, "
"url, salary, match_score, track, status, notes, found_at, description) "
"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
```

and in the args tuple, alongside the others:

```python
(job.get("description") or "")[:20000],   # cap it; some postings are enormous
```

The 20 000-char cap matters. `/api/generate` only sends the first 6 000
characters to GLM-5.2, and unbounded JD text bloats every row you read.

**Verify on a small run before trusting it.** If `job_hunt_daily.py` takes
a limit flag, use it; otherwise let one normal nightly run happen and check
after:

```bash
turso db shell morning-briefing \
  "SELECT COUNT(*) AS total,
          SUM(CASE WHEN description IS NOT NULL AND trim(description) != ''
                   THEN 1 ELSE 0 END) AS with_desc
   FROM applications
   WHERE found_at >= datetime('now', '-1 day')"
```

`with_desc` should be close to `total`. If it is 0, 3a or 3b did not take.

---

## 4. Backfill history — optional, ≤50 first

Only repairs rows that predate the column. **Expect a low hit rate**:
LinkedIn and Indeed wall headless requests, and a walled page yields
nothing. This is why §3 is the real fix and this section is optional.

```bash
# dry run, 50 rows, writes nothing
node scripts/backfill-descriptions.mjs --limit 50

# if the hit rate looks worth it
node scripts/backfill-descriptions.mjs --limit 50 --commit
```

At a 5–10s jittered delay, 50 rows takes roughly 5–8 minutes.

Guardrails already in the script: a description shorter than 200 chars is
rejected rather than written; the `UPDATE` only fills rows still empty, so
a concurrent `job_hunt_daily.py` run's fresher text is never clobbered; a
host that blocks 5 times is abandoned for the run.

Check the result, then decide whether a larger pass is worth it:

```bash
turso db shell morning-briefing \
  "SELECT COUNT(*) FROM applications
   WHERE description IS NOT NULL AND trim(description) != ''"
```

---

## 5. Ship the updated `sync_to_dashboard.py`

The repo copy now reads `description`, derives a real `summary` from it, and
excludes `expired` rows. The Pi runs its own copy, so it needs updating:

```bash
cp ~/.hermes/scripts/sync_to_dashboard.py ~/sync_to_dashboard.py.bak
cp ~/job-hunt-board/sync_to_dashboard.py ~/.hermes/scripts/sync_to_dashboard.py
```

Dry-run it against live Turso. It only writes `data/jobs.json` and git-pushes
at the very end, so check the output before letting it commit:

```bash
cd ~/.hermes/scripts
python3 -c "
import sync_to_dashboard as s
rows = s.fetch_all_jobs()
jobs = [s.transform_job(r) for r in rows]
n = sum(1 for j in jobs if (j.get('summary') or '').strip())
print(f'{n} of {len(jobs)} rows have a non-empty summary')
for j in jobs[:3]:
    print(' -', repr(j['summary'])[:120])
"
```

Before §3 has run, this still prints `0 of N` — correct, since no row has a
description yet. After a real scrape it should track the number of rows with
descriptions.

**Cron safety:** `fetch_all_jobs()` tries `SELECT ..., description` and falls
back to the base column list if the column is missing, so this copy runs
cleanly whether or not §2 was applied. Restore `~/sync_to_dashboard.py.bak`
if anything looks wrong.

**Payload note:** `jobs.json` ships only the ≤200-char excerpt, never the
full JD. At ~6 600 rows the full text would add tens of MB to a file the
browser downloads whole. The full description stays in Turso, which is where
`/api/generate` reads it. Payload splitting stays deferred, as agreed — but
`jobs.json` will still grow from ~3.4 MB to roughly ~6 MB once summaries are
populated. Worth re-measuring then.

---

## 6. Liveness pass — ≤50 first

Marks definitively-dead postings `expired` so they drop off the board.

```bash
# dry run: 50 oldest rows in the 31-60 day window, writes nothing
node scripts/check-liveness.mjs --limit 50
```

Read the output before committing anything. Three verdicts:

| verdict | meaning | writes? |
|---|---|---|
| `active` | posting still reachable | no |
| `expired` | 404/410, or the page says the job is gone, or it bounced to a search/auth page | **yes, with `--commit`** |
| `uncertain` | anti-bot wall, timeout, 5xx, ambiguous redirect | **never** |

`uncertain` is never written. That is the single most important property
here — LinkedIn and Indeed answer headless requests with walls that look
nothing like a real 404, and a wall must never cost you a live posting.

If the dry run looks sane:

```bash
node scripts/check-liveness.mjs --limit 50 --commit
```

Spot-check a few in a browser before going wider:

```bash
turso db shell morning-briefing \
  "SELECT id, company, title, url FROM applications
   WHERE status='expired' ORDER BY updated_at DESC LIMIT 10"
```

Then the full pass over the window:

```bash
node scripts/check-liveness.mjs --limit 0 --commit --json > liveness-$(date +%F).json
```

**Set expectations on the 1 894 rows.** Every URL is LinkedIn (55%), Indeed
(38%) or Adzuna (7%). A large share will come back `uncertain` because those
hosts wall headless requests — that is the script working as designed, not
failing. Expect meaningful `expired` counts from Adzuna and from LinkedIn
postings that redirect to `/jobs/search`, and a lot of `uncertain` from
Indeed. At 5–10s per row, 1 894 rows is **4–5 hours**; run it in `tmux`, and
run it outside the 9AM window so it never overlaps the cron.

If you later decide age alone is sufficient evidence for the ones that stay
`uncertain`, that is a policy call, not a liveness result — I have
deliberately not built it. Ask and I will add it behind its own flag.

**Undo**, if a batch looks wrong:

```bash
turso db shell morning-briefing \
  "UPDATE applications SET status='found'
   WHERE status='expired' AND updated_at >= datetime('now','-1 hour')"
```

---

## 7. Verify — all seven criteria, one command

```bash
cd ~/job-hunt-board
export TURSO_URL=... TURSO_TOKEN=...
node scripts/verify-goal.mjs
```

Read-only — SELECTs and GETs, never writes. It checks every success
criterion against live Turso and the live site and prints a pass/fail line
for each, exiting non-zero until all seven hold:

1. materials not served to unauthenticated enumeration (5 job_ids, expects `401`)
2. CORS pinned — unknown origin gets no `ACAO`, own origin still allowed
3. `applications.description` exists and at least one row contains a genuine
   posting body (≥200 chars, not a title-only placeholder)
4. `data/jobs.json` contains at least one genuine, non-title-echo summary
5. `generate.js` interpolates the JD into both prompts
6. rows have actually moved to `expired`
7. `jobs.json` is fresh and `/api/health` reports `configured`

Run it after each runbook section to see the count climb. Run from a
machine that can't reach production it reports 1 of 7 — that is the script
being honest, not a failure.

Then the end-to-end cron run:

After the last change, confirm a clean end-to-end run rather than waiting on
tomorrow's:

```bash
cd ~/.hermes/scripts
python3 job_hunt_daily.py && python3 sync_to_dashboard.py
```

Check, in order:

1. Both exit `0`.
2. `git -C ~/job-hunt-board log --oneline -1` shows a fresh
   `chore: daily job data update` commit.
3. Summaries are populated:
   ```bash
   python3 -c "
   import json; j=json.load(open('$HOME/job-hunt-board/data/jobs.json'))['jobs']
   print(sum(1 for x in j if (x.get('summary') or '').strip()), 'of', len(j), 'have summaries')
   print(sum(1 for x in j if x.get('has_description')), 'have full descriptions in Turso')
   "
   ```
4. Cloudflare Pages shows a green deploy for the new commit.
5. `curl -s https://jobs.arshadkazi.ca/api/health` returns
   `"configured": true`.
6. Phase 1 still holds — this must be `401`:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     https://jobs.arshadkazi.ca/api/materials/1/resume.md
   ```

Then generate materials for one job from the dashboard and open the
resume. It should quote the posting's own language. `job_details.json` in
R2 records `description_used` — if that is `false`, the row had no
description and §3 needs another look.

---

## 7a. Verify Phase 1 on the preview deployment (before merging)

Cloudflare builds a preview for this branch. Worth checking against the
real Worker before it reaches production — my own verification ran the
middleware under Node, and this environment's network policy blocks
`pages.dev`, so I could not hit the deployed copy myself.

```bash
P=https://claude-job-hunt-security-pip.job-hunt-board.pages.dev

# The vulnerability: every one of these must be 401
for id in 1 2 41 500 6595; do
  printf "job_id=%-5s -> %s\n" "$id" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$P/api/materials/$id/resume.md")"
done

# ...and must return no resume text
curl -s "$P/api/materials/41/resume.md"

# Health stays public: 200
curl -s -o /dev/null -w '%{http_code}\n' "$P/api/health"

# Mutations without a token: 401
for ep in generate applied material-links; do
  printf "%-15s -> %s\n" "$ep" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$P/api/$ep" \
        -H 'Content-Type: application/json' -d '{"job_id":41}')"
done

# CORS pinned: no access-control-allow-origin in these headers
curl -s -D - -o /dev/null -H 'Origin: https://evil.example.com' \
  "$P/api/health" | grep -i access-control-allow-origin
```

Expected: five `401`s, an empty body, `200` for health, three `401`s for
the mutations, and **no output at all** from the final `grep`.

Then the end-to-end path, in a browser on the preview URL: set your token
via 🔑 Token, generate materials for one job, and click View. Both tabs
should open. If they open blank or 401, the signed-link round trip is
broken — tell me and I will fix it before this merges.

> Preview deployments get their own hostname
> (`claude-job-hunt-security-pip.job-hunt-board.pages.dev`), which is **not**
> in the CORS allow-list. That is fine and expected: the dashboard calls its
> own origin, and same-origin requests send no `Origin` header, so CORS never
> applies. Only add a preview host to `ALLOWED_ORIGINS` if you need to call
> the API cross-origin from somewhere else.

---

## 8. Rollback

| Step | Undo |
|---|---|
| §2 migration | Nothing to undo — the column is additive, unused and NULL. SQLite `DROP COLUMN` is best avoided on live data; leaving it costs nothing. |
| §4 backfill | `UPDATE applications SET description=NULL WHERE updated_at >= datetime('now','-1 hour') AND status='found';` |
| §5 sync script | `cp ~/sync_to_dashboard.py.bak ~/.hermes/scripts/sync_to_dashboard.py` |
| §6 liveness | `UPDATE applications SET status='found' WHERE status='expired' AND updated_at >= datetime('now','-1 hour');` |
| Everything | `git -C ~/job-hunt-board checkout main`, then restore the §1 dump if Turso itself needs reverting. |

---

## 9. Corrections from the Pi execution session (2026-07-31)

Things this runbook assumed that turned out not to hold on the actual Pi.
Recorded so the next run doesn't relearn them the hard way.

- **No `turso` CLI on the Pi.** SETUP's `turso db tokens create` and every
  `turso db shell` invocation do not exist here. Everything ran over the Turso
  **HTTP v2 pipeline API** instead, using the token already at
  `~/.hermes/turso_token.txt` (the same file `turso_helper.py` reads). §1's
  backup was done with a hand-rolled `~/backup-applications.mjs` (schema + one
  INSERT per row, verified `COUNT(*) == rows == INSERT lines == 6598`), kept at
  `~/applications-backup-2026-07-31.sql`.

- **§3's core premise is wrong for this stack.** jobspy does **not** return a
  description in search results here: the MCP `scrape_jobs` tool emits a plain
  text summary (Title/Company/Location/URL/Posted) with no description field —
  even with `description_format="markdown"` — so `call_mcp_search` falls to
  `parse_mcp_text`, which sets `description = title`. `adzuna_scraper.py:124`
  likewise hardcodes `"description": title`. The §3 patch was applied faithfully
  (jobs now carry `description` into the INSERT, capped at 20k) but it can only
  ever store the **title**, not real JD prose. Real descriptions require a
  second per-posting call to the MCP's **`fetch_job`** tool — a scope addition
  (141+ extra outbound calls to LinkedIn/Indeed per run) deliberately NOT made.
  Consequence: criterion 3 passes the automated check (non-empty description),
  but the DoD "resume quotes the posting" check would expose it as title-level.

- **Baseline was 2/7, not 3/7.** Criteria 1 & 2 check the **live** site, and the
  PR was not deployed, so they read red until the merge. Criterion 5 passes off
  local source, which is why it looked like a code property.

- **Production deploys off `master`, not `main`.** `origin/HEAD -> origin/master`.
  Merging PR #2 into `main` did not go live until `master` fast-forwarded to it
  (the daily sync pushes `main:master`, which is what carried it).

- **Criterion 3 is a rolling ≤2-day window.** It counts rows with
  `found_at >= now-2days`. Today's real run refilled it; the cron is Mon–Fri, so
  it self-heals each weekday but can read red over the weekend gap until Monday's
  run. A red criterion 3 on a Saturday is expected, not a regression.

  **Superseded 2026-08-01** — this no longer holds. `checkDescriptionColumn`
  still *computes* a `recent` count, but the pass predicate is `substantial > 0`
  (any description ≥200 chars) with no recency term at all; the comment above it
  says recency-from-scrape is deliberately not required. Practical
  consequence: the §4 backfill **is** a valid
  way to turn criterion 3 green, and there is no weekend regression. Read the
  predicate, not the prose.

---

## 10. Corrections from the completion session (2026-08-01)

Reached **7 of 7**, `verify-goal.mjs` exit 0, confirmed against live production.
What this run cost, that the runbook did not warn about:

- **A stale checkout reports a confident, wrong PASS.** The Pi clone was 9
  commits behind and its `verify-goal.mjs` printed **7 of 7**. It was false:
  PR #3 (`c2ace80`) had closed a blind spot where a `summary` exactly equal to
  the job title counted as real, and the old copy still passed on those 141
  placeholder rows. After `git pull --ff-only`, the identical command honestly
  reported **5 of 7**. **`git pull` before you trust any verify output** — a
  green check from an old checkout is checking an old contract, and this
  particular one certifies the exact bug the project exists to fix.

- **`sync_to_dashboard.py` exists twice and the cron uses the copy §5 does not
  touch by default.** The Pi runs `~/.hermes/scripts/sync_to_dashboard.py`; the
  repo has its own. They are not symlinked. Only the repo copy carries
  `MIN_DESCRIPTION_CHARS` and `is_title_only()`, which is what lets a real
  summary be derived and a title-echo be rejected. **Until you actually perform
  §5's `cp`, criterion 4 cannot go green** regardless of how many genuine
  descriptions reach Turso — the sync will keep re-emitting title echoes. §9
  never recorded doing it, so assume it has not been done.

  **Resolved after handoff:** `run-phase2.sh` now compares the two copies,
  creates a timestamped backup, and installs the repo copy before syncing. It
  refuses to run a differing cron copy unless that installation is approved.

- **Do not run `scripts/run-phase2.sh` over non-interactive SSH.** Its
  `confirm()` reads from stdin via `read -rp`. With no TTY, `read` hits EOF, the
  reply stays empty, and **every write step silently skips** — and since the
  script sets `-uo pipefail` but not `-e`, it continues and still prints a final
  verify. The run looks like it happened and changed nothing. Either run it on a
  real terminal, or call `check-liveness.mjs` / `backfill-descriptions.mjs`
  directly with an explicit `--commit`, which is what this session did. `--yes`
  works but also auto-approves the production push.

  **Resolved after handoff:** interactive mode now fails immediately when stdin
  is not a TTY, every fetch step propagates failures, and `--yes` remains the
  explicit non-interactive path. The sync script also returns non-zero when its
  commit or either branch push fails.

- **Backfill economics, measured.** `--limit 50 --order score` extracted **18 of
  50** (~36%), bodies 1.8K–10.5K chars — enough to satisfy criteria 3 and 4 in
  one pass. `ca.indeed.com` blocked 5× and was abandoned mid-run, as designed.

- **The full liveness pass is not on the critical path.** Criterion 6 was
  already green at 45 expired rows. The remaining 1 894-row window is 4–5 hours
  and moves no criterion; run it as cleanup if you want a tidier board, not as
  part of reaching the goal.
