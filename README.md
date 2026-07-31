# Job Hunt Board

A single-page job hunt dashboard deployed on **Cloudflare Pages** that renders a daily-refreshed, ranked table of scraped jobs (EV Commercial + AI/Engineering tracks), generates tailored resumes & cover letters via **GLM-5.2**, and tracks application status.

- **Live URL:** `jobs.arshadkazi.ca` (Cloudflare Pages)
- **Repo:** `github.com/arshad1416/job-hunt-board`
- **Architecture:** [ARCHITECTURE_PLAN.md](./ARCHITECTURE_PLAN.md)

---

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

The frontend is **static-first** — it reads `data/jobs.json` (committed daily by the Pi) and never hits the database at render time. Cloudflare Pages Functions are used only for mutations (generate materials, toggle applied) and file serving.

---

## File Structure

```
job-hunt-board/
├── index.html                          # Single-page dashboard shell
├── style.css                           # Dark theme styles
├── app.js                              # Frontend controller (fetch, render, filter, actions)
├── _routes.json                        # Only /api/* runs as Functions
├── wrangler.jsonc                      # Cloudflare Pages config (non-secret bindings)
├── README.md                           # This file
├── .gitignore
├── data/
│   └── jobs.json                       # Daily-exported job data (Pi writes, git-tracked)
└── functions/
    ├── _lib/
    │   ├── turso.js                    # Shared Turso v2 pipeline helper
    │   └── signing.js                  # HMAC-signed, time-limited material links
    └── api/
        ├── _middleware.js              # Pinned CORS + auth gate for /api/*
        ├── health.js                   # GET  /api/health          (public)
        ├── generate.js                 # POST /api/generate
        ├── applied.js                  # POST /api/applied
        ├── material-links.js           # POST /api/material-links  (mints signed URLs)
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
| `OPENCODE_GO_API_KEY` | **secret** | dashboard only | OpenCode Go API key for GLM-5.2. |
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
| `POST /api/generate`, `POST /api/applied` | `X-Auth-Token` required. |

Signed links are HMAC-SHA256 over `v1:<job_id>:<filename>:<exp>` (see `functions/_lib/signing.js`). A token is bound to one job **and** one filename, so it cannot be walked sideways to another posting or another file, and it expires on its own. Browser tabs can't send custom headers, which is why signed URLs exist — `viewMaterials()` in `app.js` opens the tabs, then points them at freshly signed URLs.

CORS is pinned to the allow-list above; an unrecognised `Origin` receives no `Access-Control-Allow-Origin` header at all. Responses carry `Vary: Origin`. Material responses are served `private, no-store` with `nosniff` and `X-Robots-Tag: noindex`.

If `DASHBOARD_AUTH_TOKEN` is unset on the server, every non-public route fails closed with `503` rather than opening up.

### Turso

- **Endpoint:** `https://morning-briefing-arshad1416.aws-us-east-1.turso.io/v2/pipeline`
- **Auth:** `Authorization: Bearer <TURSO_TOKEN>`
- **Table:** `applications` (schema in [ARCHITECTURE_PLAN.md](./ARCHITECTURE_PLAN.md) §5.1)
- The `applications` table has `found_at` and `notes` columns (no `posted_at` or `description`). The frontend derives posted date from `found_at` and summary from `notes` when `posted_date`/`summary` are absent in `jobs.json`.

### OpenCode Go API (GLM-5.2)

- **Endpoint:** `https://opencode.ai/zen/go/v1/chat/completions`
- **Model:** `glm-5.2`
- **Auth:** `Authorization: Bearer <OPENCODE_GO_API_KEY>`
- Called by `/api/generate` to produce `resume.md` and `cover_letter.md` per job.

---

## API Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | none | Liveness + config check (`{ok, configured, config}`) |
| `POST` | `/api/generate` | `X-Auth-Token` | Generate resume + cover letter via GLM-5.2, store in R2, update Turso status |
| `POST` | `/api/applied` | `X-Auth-Token` | Toggle applied status in Turso |
| `GET` | `/api/materials/:job_id/:filename` | none | Serve generated materials from R2 (public for browser tab access) |

**Auth:** Mutations (`generate`, `applied`) require header `X-Auth-Token: <DASHBOARD_AUTH_TOKEN>`. The browser stores this token in `localStorage` (set via the 🔑 Token button). Materials and health are public.

---

## Cloudflare Pages Setup (Step-by-Step)

> Cloudflare Pages is **not yet provisioned**. Follow these exact steps.

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
| `OPENCODE_GO_API_KEY` | **Encrypted** | *(your OpenCode Go API key)* |
| `DASHBOARD_AUTH_TOKEN` | **Encrypted** | *(generate: `openssl rand -hex 32`)* |

3. After adding all variables, **redeploy** (Settings changes require a new deployment to take effect)

#### Via Wrangler CLI (alternative)
```bash
npx wrangler pages secret put TURSO_TOKEN          --project-name job-hunt-board
npx wrangler pages secret put OPENCODE_GO_API_KEY  --project-name job-hunt-board
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
OPENCODE_GO_API_KEY=your_opencode_key
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
- **Stats bar** — Total, New (24h), EV, AI, Applied, Materials Ready
- **Generate modal** — shows spinner → success with download links, or error
- **Applied checkbox** — optimistic UI with server sync and rollback on failure
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
      "posted_date": "2026-06-18",
      "found_at": "2026-06-19 13:00:11",
      "has_materials": false
    }
  ]
}
```

> **Note:** The Turso `applications` table does NOT have `posted_at` or `description` columns. The frontend falls back to `found_at` for posted date and parses `notes` for summary when `posted_date`/`summary` are not present in the JSON.

---

## Scoring Algorithm

Score = **title (40%) + skills (30%) + location (15%) + remote fit (15%)**, with capped bonuses for seniority (+10) and target OEMs (+8). See [ARCHITECTURE_PLAN.md](./ARCHITECTURE_PLAN.md) §6 for full pseudocode.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (no framework, no build step) |
| Edge Functions | Cloudflare Pages Functions (Workers runtime) |
| Database | Turso (libSQL) — HTTP v2 pipeline API |
| Object Storage | Cloudflare R2 (`job-hunt-materials` bucket) |
| AI Generation | GLM-5.2 via OpenCode Go API |
| Hosting | Cloudflare Pages |
| Data Pipeline | Raspberry Pi 5 cron + jobspy-js MCP |

---

## License

Personal project — Arshad Kazi. Not for redistribution.
