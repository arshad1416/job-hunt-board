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

## 7. Verify the 9AM ET cron

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
