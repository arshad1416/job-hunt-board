# Job Hunt Dashboard

Daily scored job listings for Arshad Kazi — EV Commercial + AI/Engineering tracks.

## Architecture

```
Pi cron (9AM ET Mon-Fri):
  job_hunt_daily.py → Turso DB → sync_to_dashboard.py
  → git push to this repo → Cloudflare Pages auto-deploys

Cloudflare Pages (jobs.arshadkazi.ca):
  index.html + app.js → reads data/jobs.json → renders table

Cloudflare Workers (functions/):
  POST /api/generate  → GLM-5.2 → resume + cover letter → R2
  POST /api/applied   → Turso update → status toggle
  GET  /api/materials/:id/:file → serve generated files
```

## Deploy Steps

### 1. Cloudflare Pages Setup
1. Go to **Cloudflare Dashboard → Pages**
2. Click **Create a project → Connect to Git**
3. Select `arshad1416/job-hunt-board`
4. **Build settings:**
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: **/** (root)
5. Click **Deploy**

### 2. Add Environment Variables (Secrets)
In Cloudflare Pages → project → **Settings → Environment variables**:

| Variable | Value |
|---|---|
| `OPENCODE_GO_API_KEY` | Your OpenCode Go API key |
| `TURSO_URL` | `https://morning-briefing-arshad1416.aws-us-east-1.turso.io` |
| `TURSO_TOKEN` | Your Turso database token |

### 3. Add R2 Bucket Binding
Still in Cloudflare Pages → **Settings → Functions**:

- **R2 bucket binding**
  - Variable name: `JOB_MATERIALS_BUCKET`
  - Bucket name: `job-hunt-materials` (create this in R2 first)

### 4. Custom Domain (Optional)
- Cloudflare Pages → project → **Custom domains**
- Add: `jobs.arshadkazi.ca`
- Update DNS at your registrar

## Local Development

```bash
# Serve locally
npx wrangler pages dev .
```

## Data Flow

1. **Pi (9AM ET):** `job_hunt_daily.py` scrapes jobs → scores → inserts into Turso
2. **Pi (after pipeline):** `sync_to_dashboard.py` reads Turso → writes `data/jobs.json` → git push
3. **Cloudflare Pages:** Auto-deploys when git push triggers webhook
4. **Browser:** Dashboard fetches `data/jobs.json` + renders table
5. **User clicks "Generate":** POST to `/api/generate` → Worker calls GLM-5.2 → stores in R2
6. **User clicks "Applied ✓":** POST to `/api/applied` → Worker updates Turso
