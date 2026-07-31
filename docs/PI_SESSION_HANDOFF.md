# Handoff brief — for a Claude Code session running on the Pi

Hand this file to a session that has the Pi's filesystem and network. It is
self-contained: assume the reader has no prior context.

## Why this exists

Phases 1 and 2 were built in a cloud container that could not reach the Pi
or live Turso — no credentials, and the network policy blocked both the
Turso host and `jobs.arshadkazi.ca`. All the code is written, tested and
pushed. What remains is execution against production, which only a session
on the Pi can do.

## Starting state

Branch `claude/job-hunt-security-pipeline-p7f9oy`, PR
[#2](https://github.com/arshad1416/job-hunt-board/pull/2), CI green.

Seven success criteria. **Three already hold** — they are properties of the
code and need nothing further:

1. ✅ `/api/materials/:job_id/:filename` no longer serves resumes to
   unauthenticated callers enumerating numeric job_ids
2. ✅ `_middleware.js` CORS pinned to the domain, not `*`
5. ✅ `generate.js` passes the JD body to GLM-5.2

**Four need production execution** — this is the whole job:

3. ❌ `applications` has a `description` column, populated by a real
   `job_hunt_daily.py` run
4. ❌ `data/jobs.json` rows have a non-empty summary (0 of 6595 today)
6. ❌ Liveness pass marks dead postings `expired` (1894 rows are 31–60 days
   old and still `found`)
7. ❌ The 9AM ET cron completes cleanly after every change

## Constraints that still bind

- **Back up `applications` before any DDL.** Additive migration only.
- **Test liveness and description backfill on ≤50 rows** before a full run.
- **Do NOT trigger a full re-scrape.** LinkedIn/Indeed will rate-limit.
  Liveness re-checks URLs already on file, one at a time, jittered 5–10s.
- **Never commit secrets.** `.env` and `.dev.vars` stay gitignored.
- **Static-first**: no framework, no build step.
- **Do NOT add** dedup, trust scoring, LLM rubric scoring, or payload
  splitting — deferred until the row count is re-measured.
- **Ask before deleting or overwriting anything** in `data/` or Turso.

## Do this

```bash
cd ~/job-hunt-board
git fetch origin && git checkout claude/job-hunt-security-pipeline-p7f9oy
export TURSO_URL="https://morning-briefing-arshad1416.aws-us-east-1.turso.io"
export TURSO_TOKEN="$(turso db tokens create morning-briefing)"

node scripts/verify-goal.mjs   # baseline: expect 3 of 7
```

Then work `docs/PHASE2_RUNBOOK.md` §1–§6 in order. It is written to be
followed literally; every writing script is dry-run by default and needs an
explicit `--commit` or `--confirm`.

Re-run `node scripts/verify-goal.mjs` after each section and watch the count
climb. It is read-only and exits non-zero until all seven hold.

## The two steps that need judgment, not just execution

**§3 — patching `job_hunt_daily.py`.** This file lives only at
`~/.hermes/scripts/` and was not visible to the session that wrote the
runbook, so the variable names in §3 are *illustrative*. Read the real file
first. Two changes: ask jobspy for description text
(`description_format="markdown"`), and carry `description` into the
`INSERT INTO applications` statement, capped at 20 000 chars. This is the
step that actually satisfies criterion 3 — the backfill in §4 is repair work
and optional.

**§6 — the liveness dry run.** Inspect the verdicts before passing
`--commit`. Expect a lot of `uncertain`: every URL is LinkedIn (55%),
Indeed (38%) or Adzuna (7%), and the first two wall headless requests.
`uncertain` is never written, by design — an anti-bot wall must never cost
a live posting. That is the script working, not failing.

At 5–10s per row, the full 1894-row pass is 4–5 hours. Run it in `tmux`,
outside the 9AM window so it never overlaps the cron.

## Definition of done

```bash
node scripts/verify-goal.mjs   # 7 of 7, exit 0
```

Plus one end-to-end sanity check: generate materials for a job from the
dashboard and open the resume. It should quote the posting's own language.
`job_details.json` in R2 records `description_used` — if that is `false`,
the row had no description and §3 needs another look.

## Then

Report the `verify-goal.mjs` output, mark PR #2 ready for review, and note
anything the runbook got wrong so it can be corrected.
