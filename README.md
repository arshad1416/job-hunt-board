# Job Hunt Board

A single-page job hunt dashboard deployed on **Cloudflare Pages** that renders a daily-refreshed, ranked table of scraped jobs (EV Commercial + AI/Engineering tracks), generates tailored resumes & cover letters via **GLM 5.3 via 9Router** (9Router), and tracks application status.

- **Live URL:** `jobs.arshadkazi.ca` (Cloudflare Pages)
- **Repo:** `github.com/arshad1416/job-hunt-board`
- **Architecture:** [`wrangler.jsonc`](./wrangler.jsonc), Pages Functions under [`functions/`](./functions/), and the adoption contract in [`docs/UPSTREAM-ADOPTION-MATRIX.md`](./docs/UPSTREAM-ADOPTION-MATRIX.md)

---

## Task 4 materials worker

Run `node scripts/render-jobs.mjs --dry-run --limit 10` on the Pi only. Chromium is Pi-local; the worker polls Turso under the existing lock, recovers stale leases, and uses bounded retries. PDFs are private, signed with version-bound URLs, and legacy Markdown remains supported. Migration 003 owns render jobs. No production canary has been run locally.

## Task 4 materials

The Pi worker runs `node scripts/render-jobs.mjs --dry-run` (optionally `--limit N`) with Pi-local Chromium, polling Turso under the existing lock. It recovers stale leases with bounded retries. PDFs are private, no-store, and signed with version-bound URLs; legacy Markdown remains supported. Migration 003 owns render jobs. Local verification is not a production canary.

## Task 4 material delivery

Material links expose Markdown/details immediately; PDF links appear only after verified versioned source integrity, successful render state, and both exact PDF objects. Errors are private/no-store and PDFs are never served through legacy flat paths.

## Task 4 delivery

Run the Pi-only worker with `node scripts/render-jobs.mjs --dry-run --limit 10`; it polls Turso under the existing lock, recovers stale leases, and uses bounded exponential retries. PDFs require verified versioned sources and successful pair rendering; signed URLs are private/no-store and legacy Markdown remains supported. No production canary has been run.

## Task 4 delivery operations

Run the Pi-only `node scripts/render-jobs.mjs --dry-run --limit 10` worker. It polls Turso under the existing lock, recovers stale leases, and applies bounded retries. Private PDFs require verified versioned sources and successful render readiness; signed URLs include the version. Legacy Markdown remains supported. No production canary has been run.

## Task 4 delivery contract

Migration 003 owns the single pair render job per material version. The Pi-only worker polls Turso under the existing lock with `--dry-run` and `--limit`; stale leases recover with bounded retries. PDFs require verified versioned source, successful pair state, and both exact objects. Signed links are private and version-bound; legacy Markdown remains supported. No production canary has been run.

## How It Works

```
Pi 5 (cron 9AM ET)
  job_hunt_daily.py → scrape → score → Turso insert
  sync_to_dashboard.py → Turso read → data/jobs.json → git push
                                                    ↓
Cloudflare Pages (auto-deploy on push)
  Static: index.html + style.css + app.js + data/jobs.json
  Functions (/api/*): generate, applied, materials, health
```

The frontend is **static-first** — it reads `data/jobs.json` (committed daily by the Pi) and never hits the database at render time. Cloudflare Pages Functions handle authenticated mutations (generation, status, follow-up drafts) and file serving.

---

## File Structure

```
job-hunt-board/
├── index.html                          # Single-page dashboard shell
├── style.css                           # Dark theme styles
├── app.js                              # Frontend controller (fetch, render, filter, actions)
├── _routes.json                        # Only /api/* runs as Functions
├── wrangler.jsonc                      # Cloudflare Pages config (non-secret bindings)
├── migrations/                         # Additive Turso schema migrations
├── scripts/lib/public_ats.py           # Opt-in Greenhouse/Lever/Ashby board APIs
├── README.md                           # This file
├── .gitignore
├── data/
│   └── jobs.json                       # Daily-exported job data (Pi writes, git-tracked)
└── functions/
    ├── _lib/
    │   ├── turso.js                    # Shared Turso v2 pipeline helper
    │   ├── cv-gates.js                 # Deterministic facts, ATS, keyword, simhash gates
    │   ├── generation-quality.js       # Reviewer/reuse quality helpers
    │   ├── followup-draft.js           # Follow-up prompt validation and redaction
    │   ├── status.js                   # Shared application status vocabulary
    │   ├── job-hunter-skill.js         # R2 skill/profile key constants
    │   └── signing.js                  # HMAC-signed, time-limited material links
    └── api/
        ├── _middleware.js              # Pinned CORS + auth gate for /api/*
        ├── health.js                   # GET  /api/health          (public)
        ├── generate.js                 # POST /api/generate
        ├── applied.js                  # POST /api/applied
        ├── material-links.js           # POST /api/material-links  (mints signed URLs)
        ├── status.js                  # POST/GET /api/status + status ledger
        ├── followup-draft.js          # POST /api/followup-draft
        └── materials/
            └── [job_id]/
                └── [filename].js       # GET  /api/materials/:job_id/:filename
```

---

## Environment Variables & Bindings

All configured in the **Cloudflare Pages dashboard** (Settings → Environment variables / Functions → Bindings). Non-secret bindings are mirrored in `wrangler.jsonc`.

| Variable | Type | Where | Example / Notes |
|---|---|---|---|
| `TURSO_URL` | plaintext var | dashboard + `wrangler.jsonc` | `https://morning-briefing-arshad1416.aws-us-east-1.turso.io` |
| `TURSO_TOKEN` | **secret** | dashboard only | Turso DB auth token (Bearer). Same token the Pi uses. |
| `NINEROUTER_API_KEY` | **secret** | dashboard only | 9Router API key for GLM 5.3 via 9Router resume generation. |
| `DASHBOARD_AUTH_TOKEN` | **secret** | dashboard only | Shared secret for all `/api/*` routes except `/api/health`. Browser sends `X-Auth-Token` header. Generate with `openssl rand -hex 32`. |
| `MATERIALS_SIGNING_KEY` | **secret** _(optional)_ | dashboard only | HMAC key for signed material links. Falls back to `DASHBOARD_AUTH_TOKEN` when unset. Set it to rotate material links independently of the dashboard token. |
| `ALLOWED_ORIGINS` | plaintext var _(optional)_ | dashboard only | Comma-separated CORS allow-list. Defaults to `https://jobs.arshadkazi.ca`, `https://job-hunt-board.pages.dev`, `http://localhost:8788`. |
| `JOB_MATERIALS_BUCKET` | R2 binding | dashboard + `wrangler.jsonc` | R2 bucket name: `job-hunt-materials` |

### API Security Model

| Route | Access |
|---|---|
| `GET /api/health` | Public (uptime monitors). Returns booleans only — never values. |
| `GET /api/materials/:job_id/:filename` | **Not public.** Requires an `X-Auth-Token` header, or a signed `?token=` minted by `/api/material-links`. Enumerating numeric `job_id`s returns `401`. |
| `POST /api/material-links` | `X-Auth-Token` required. Returns 15-minute signed URLs for one job's materials. |
| `POST /api/generate`, `POST /api/applied`, `POST /api/status`, `POST /api/followup-draft` | `X-Auth-Token` required. |

Signed links are HMAC-SHA256 over `v1:<job_id>:<filename>:<exp>` (see `functions/_lib/signing.js`). A token is bound to one job **and** one filename, so it cannot be walked sideways to another posting or another file, and it expires on its own. Browser tabs can't send custom headers, which is why signed URLs exist — `viewMaterials()` in `app.js` opens the tabs, then points them at freshly signed URLs.

CORS is pinned to the allow-list above; an unrecognised `Origin` receives no `Access-Control-Allow-Origin` header at all. Responses carry `Vary: Origin`. Material responses are served `private, no-store` with `nosniff` and `X-Robots-Tag: noindex`.

If `DASHBOARD_AUTH_TOKEN` is unset on the server, every non-public route fails closed with `503` rather than opening up.

### Turso

- **Endpoint:** `https://morning-briefing-arshad1416.aws-us-east-1.turso.io/v2/pipeline`
- **Auth:** `Authorization: Bearer <TURSO_TOKEN>`
- **Table:** `applications` (schema and additive migrations in `migrations/`)
- The `applications` table uses `found_at` for posted date and now has an
  additive `description` column. Structured ingestion stores genuine bodies
  when the search source provides them; missing bodies are resolved and cached
  on demand. `sync_to_dashboard.py` derives the short dashboard summary from
  that body, with legacy `notes` as a fallback.

### 9Router API (GLM 5.3 via 9Router)

- **Endpoint:** `https://9router.arshadkazi.ca/v1/chat/completions` (Cloudflare Tunnel to 9Router on the Pi; OpenAI-compatible)
- **Model:** `cc/claude-opus-5`
- **Auth:** `Authorization: Bearer <NINEROUTER_API_KEY>`
- Requests must set `stream: false` — 9Router streams by default.
- Called by `/api/generate` to produce `resume.md` and `cover_letter.md` per job.
- **Prompts follow the `job-hunter` skill** (hermes-skills repo, `profiles/job-hunter`):
  each generation tailors against the structured master profile and a same-track
  reference resume loaded from private R2 objects
  (`assets/resume_profile.yaml`, `assets/master_resume_{ev,ai}.md` — refresh via
  `npx wrangler r2 object put`), enforces the skill's ATS output standards and
  truthful-only ground rules, and fails closed with a configuration error when
  private R2 profile objects are unavailable.

---

## API Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | none | Liveness + config check (`{ok, configured, config}`) |
| `POST` | `/api/generate` | `X-Auth-Token` | Generate resume + cover letter via GLM 5.3 via 9Router, run deterministic quality gates, store in R2, update Turso status |
| `POST` | `/api/applied` | `X-Auth-Token` | Legacy toggle; also maintains applied/follow-up bookkeeping |
| `POST` | `/api/status` | `X-Auth-Token` | Set extended lifecycle status and append status ledger event |
| `GET` | `/api/status?job_id=N` | `X-Auth-Token` | Read status ledger for one job |
| `POST` | `/api/followup-draft` | `X-Auth-Token` | Generate a bounded follow-up draft for eligible statuses |
| `GET` | `/api/materials/:job_id/:filename` | signed `?token=` or `X-Auth-Token` | Serve generated materials from R2 (browser tabs open short-lived signed links) |

**Auth:** Mutations (`generate`, `applied`, `status`, `followup-draft`) require header `X-Auth-Token: <DASHBOARD_AUTH_TOKEN>`. The browser stores this token in `localStorage` (set via the 🔑 Token button). Health is public.

---

## Cloudflare Pages Setup (Step-by-Step)

> Cloudflare Pages is configured through `wrangler.jsonc`; verify environment-specific bindings and secrets before deployment.

### 1. Create R2 Bucket

1. Cloudflare Dashboard → **R2** → **Create bucket**
2. Name: `job-hunt-materials`
3. Region: Auto
4. Click **Create**

### 2. Connect Pages to GitHub

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Authorize GitHub if prompted
3. Select repository: `arshad1416/job-hunt-board`
4. **Production branch:** `main`
5. **Build settings:**
   - Framework preset: **None**
   - Build command: *(leave empty — no build step)*
   - Build output directory: `/` (root)
6. Click **Save and Deploy**

### 3. Add Bindings & Secrets

In the Pages project → **Settings**:

#### R2 Bucket Binding
1. **Functions** → **R2 bucket bindings** → **Add binding**
2. Variable name: `JOB_MATERIALS_BUCKET`
3. R2 bucket: `job-hunt-materials`

#### Environment Variables (Production)
1. **Environment variables** → **Add variable**
2. Add each:

| Variable | Type | Value |
|---|---|---|
| `TURSO_URL` | Plaintext | `https://morning-briefing-arshad1416.aws-us-east-1.turso.io` |
| `TURSO_TOKEN` | **Encrypted** | *(your Turso auth token)* |
| `NINEROUTER_API_KEY` | **Encrypted** | *(your 9Router API key)* |
| `DASHBOARD_AUTH_TOKEN` | **Encrypted** | *(generate: `openssl rand -hex 32`)* |

3. After adding all variables, **redeploy** (Settings changes require a new deployment to take effect)

#### Via Wrangler CLI (alternative)
```bash
npx wrangler pages secret put TURSO_TOKEN          --project-name job-hunt-board
npx wrangler pages secret put NINEROUTER_API_KEY    --project-name job-hunt-board
npx wrangler pages secret put DASHBOARD_AUTH_TOKEN --project-name job-hunt-board
```

### 4. Verify Deployment

```bash
# Check health endpoint
curl https://<project>.pages.dev/api/health
# Expected: {"ok":true,"configured":true,"config":{...all true...}}

# Visit the dashboard
open https://<project>.pages.dev
```

### 5. Custom Domain (Optional)

1. Pages project → **Custom domains** → **Set up**
2. Domain: `jobs.arshadkazi.ca`
3. If `arshadkazi.ca` is on Cloudflare DNS → CNAME auto-provisions
4. Otherwise add CNAME `jobs` → `<project>.pages.dev` at your registrar

---

## Local Development

```bash
# Install wrangler (if not already)
npm install -g wrangler

# Create .dev.vars file (gitignored) with secrets:
cat > .dev.vars << 'EOF'
TURSO_TOKEN=your_turso_token
NINEROUTER_API_KEY=your_9router_key
DASHBOARD_AUTH_TOKEN=your_auth_token
EOF

# Run local dev server
npx wrangler pages dev . \
  --binding JOB_MATERIALS_BUCKET=job-hunt-materials \
  --var TURSO_URL:https://morning-briefing-arshad1416.aws-us-east-1.turso.io

# Open http://localhost:8788
```

---

## Frontend Features

- **Dark theme** — GitHub-style dark color scheme
- **Score bars** — green (≥70), amber (50–69), red (<50)
- **Track badges** — EV = blue, AI = purple
- **Client-side filtering** — track, min-score, status, search (no re-fetch on filter change)
- **Stats bar** — Total, New (24h), EV, AI, Applied, Follow-ups Due, Materials Ready
- **Generate modal** — shows spinner, ATS/fact quality summary, download links, and follow-up draft action
- **Status lifecycle** — found → materials_ready → saved → applied → screening → interview → offer/rejected/ghosted, with optimistic sync and rollback
- **Token management** — auth token stored in `localStorage`, set via 🔑 Token button
- **Responsive** — works on mobile (hides summary/location columns on small screens)

---

## Data Schema (`data/jobs.json`)

Written daily by the Pi's `sync_to_dashboard.py`:

```json
{
  "meta": {
    "updated": "2026-06-19",
    "count": 42,
    "generated_at": "2026-06-19T13:02:11Z",
    "tracks": { "ev_commercial": 18, "ai_engineering": 21, "other": 3 }
  },
  "jobs": [
    {
      "id": 123,
      "title": "Regional Sales Manager — EV",
      "company": "BYD Canada",
      "location": "Toronto, ON",
      "url": "https://...",
      "salary": "$120K–$150K",
      "score": 92,
      "track": "ev_commercial",
      "status": "found",
      "source": "indeed",
      "summary": "Lead Ontario dealer network development…",
      "description": "Lead Ontario dealer network development…",
      "has_description": true,
      "posted_date": "2026-06-18",
      "found_at": "2026-06-19 13:00:11",
      "has_materials": false,
      "deadline": "2026-09-30",
      "deadline_status": "open",
      "urgency": "high",
      "is_repost": false,
      "gate": "",
      "follow_up_due": "",
      "quality": null
    }
  ]
}
```

> **Note:** The Turso `applications` table has no `posted_at` column — `found_at` stands in for posted date.
>
> `description` **is** an `applications` column as of `migrations/001_add_description_column.sql`, and `/api/generate` sends it to GLM 5.3 via 9Router so resumes are written from the posting text rather than the job title.
>
> **Descriptions and canonical URLs are captured without a per-posting board crawl.** `scripts/jobspy_json.mjs` calls jobspy's structured API instead of its lossy MCP summary, preserving the description and `job_url_direct` fields already present in search results. The employer/ATS URL is promoted over the LinkedIn/Indeed URL and known Recruitics tracking hops are removed. LinkedIn's optional per-result description request stays off by default because it is the block-prone path. When a description is still missing, `/api/generate` tries the posting's public Greenhouse, Lever, Workday, or SmartRecruiters endpoint first, then performs one bounded HTML fetch and caches the result. A title echo or text under 120 characters is treated as absent.
>
> `jobs.json` deliberately ships only a ≤200-char excerpt in `summary`/`description`, plus a `has_description` boolean. At ~6.6K rows the full JD text would add tens of MB to a file the browser downloads whole; the full text stays in Turso where the API reads it. Summaries were empty on every row until this landed, because the old code derived them solely from a `Summary:` fragment in `notes` that the pipeline never wrote.

---

## Maintenance Scripts

Zero-dependency Node 18+ (global `fetch`), run from the Pi. **All are dry-run by default** and need an explicit `--commit`/`--confirm` to write. See [docs/PHASE2_RUNBOOK.md](./docs/PHASE2_RUNBOOK.md) for the full procedure.

| Script | Purpose |
|---|---|
| `scripts/add-description-column.mjs` | Applies the additive `description` migration. Idempotent — checks `PRAGMA table_info` first and re-counts rows after. |
| `scripts/jobspy_json.mjs` | Structured ingestion bridge. Preserves descriptions and employer URLs without enabling per-result LinkedIn detail requests. |
| `scripts/check-liveness.mjs` | Marks dead postings `expired`. Public ATS API first, HTML second; **`uncertain` is never written**, so an access wall cannot cost you a live posting. |
| `scripts/backfill-descriptions.mjs` | Repairs old rows through public ATS APIs first, with the existing bounded HTML fallback. |
| `scripts/verify-goal.mjs` | **Read-only.** Checks all seven success criteria against live Turso and the live site; exits non-zero until every one holds. |

```bash
export TURSO_URL=... TURSO_TOKEN=...
node scripts/check-liveness.mjs --limit 50            # dry run
node scripts/check-liveness.mjs --limit 50 --commit   # apply
```

The API-first provider, three-way liveness strategy, URL fingerprints, and bounded follow-up cadence are adapted from [santifer/career-ops](https://github.com/santifer/career-ops). The job scoring/gating and truthful application workflow also borrow the useful separation in [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search). This repo keeps the core path zero-dependency: recognized employer ATS endpoints are preferred, and blocked board responses remain `uncertain`. The Pi board-ingestion allowlist is Greenhouse/Lever/Ashby; the generator's URL-derived detail fallback additionally supports Workday and SmartRecruiters without accepting arbitrary API targets.

---

## Scoring Algorithm

Score = **title (40%) + skills (30%) + location (15%) + remote fit (15%)**, with capped bonuses for seniority (+10) and target OEMs (+8). The scoring implementation lives in the Pi ingestion pipeline.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (no framework, no build step) |
| Edge Functions | Cloudflare Pages Functions (Workers runtime) |
| Database | Turso (libSQL) — HTTP v2 pipeline API |
| Object Storage | Cloudflare R2 (`job-hunt-materials` bucket) |
| AI Generation | GLM 5.3 via 9Router via 9Router |
| Hosting | Cloudflare Pages |
| Data Pipeline | Raspberry Pi 5 cron + jobspy structured ingestion |

---

## License

Personal project — Arshad Kazi. Not for redistribution.
## Task 4 operations

Apply migrations 003 then additive 007. Run `node scripts/render-jobs.mjs --dry-run --limit 10` on the Pi for verification; production removes `--dry-run`. The worker uses a lock, stale-lease recovery, and bounded retries. Signed URLs are private/no-store and bind job, filename, version, and expiry. Legacy Markdown only is supported; PDFs require versioned readiness. Failed renders retry. No production canary has been run.
