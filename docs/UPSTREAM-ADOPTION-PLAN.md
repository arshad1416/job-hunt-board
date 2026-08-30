# Job Hunt Board Upstream Adoption and Document Production Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the board a reliable application workbench that produces truthful, ATS-readable PDF resumes and cover letters while selectively adopting the useful, architecture-compatible parts of `ai-job-search` and `career-ops`.

**Architecture:** Keep generated Markdown as the canonical source in private R2. Add a versioned material manifest keyed by job-description, profile, and template hashes; render deterministic HTML/CSS to PDF on the Pi, where Chromium runs with no network access, then upload derived PDFs back to R2. Keep Turso as the live lifecycle/status source and the committed JSON as a discovery read model; measure the current synchronous generator before deciding whether to put it behind a Queue.

**Tech Stack:** Cloudflare Pages Functions, Turso HTTP v2, R2, Raspberry Pi cron/lock, Node.js, Playwright Chromium, Poppler/pdftotext, existing vanilla HTML/CSS UI, Node/Python tests.

---

## Review basis and decisions

This plan incorporates independent upstream audits, a current-board audit, and a Cloudflare architecture/security review. The upstream repositories are different kinds of systems: `ai-job-search` is an agent-driven Claude Code workflow with LaTeX/Python helpers; `career-ops` is a local Node/Playwright/SQLite/Go/Next.js workbench. Neither should be copied wholesale into this Pages app. The plan was also subjected to a read-only Codex review attempt; the review process did not produce a usable verdict, so no approval is claimed here.

### Adopt
- PDF production concepts: fixed templates, ATS-safe typography, escaped values, page limits, placeholder checks, text extraction, and visual/geometry regression fixtures.
- Immutable artifact history and explicit reuse decisions, adapted to R2/Turso rather than Markdown tracker files.
- Existing evidence-grounded fact checks and deterministic ATS/reuse gates.
- Confirm-before-write profile intake, limited initially to PDF/text extraction.
- A canonical validated status path, live-status reconciliation, deadline/urgency/repost/gate visibility, evidence-only knockout warnings, preflight, and structured render outcomes.

### Deferred

These are viable future enhancements, but they are not required for the current board’s core workflow. Each should return only when a measured user need justifies its added scope:

- Full provider ecosystem / roughly 90-board scanner.
- Generic interview preparation, company/interviewer research, offer and negotiation support, salary-gap analytics, and richer follow-up cadence.
- OCR and DOCX intake.
- LaTeX/CJK support.
- Additional resume and cover-letter templates beyond the initial ATS template.
- Generic interview practice mode and batch generation.
- Asynchronous LLM generation, pending measured latency/error data. PDF rendering is asynchronous immediately because Chromium is not a Pages Function concern.

### Rejected

These are intentionally excluded from this application because they conflict with its safety model, runtime, or product boundary:

- **Automatic application submission and browser autofill** — they create high-risk irreversible actions, depend on interactive browser automation, and violate the board’s human-in-the-loop/no-submit boundary.
- **Gmail, Notion, Calendar, Apify, and third-party plugin-registry integrations in the public app** — they add OAuth credentials, third-party supply-chain/API risk, and privacy scope without a current product requirement.
- **Browser Rendering/Chromium in Workers, or any renderer that can fetch URLs from untrusted job descriptions** — Chromium is not a suitable Pages Function workload here, and remote resource fetching reopens SSRF/data-exfiltration risk. Rendering belongs on the isolated Pi from fixed local inputs.
- **LLM-generated PDFs** — layout must be deterministic and testable; the LLM should produce truthful content, while the renderer produces the PDF projection.
- **Markdown-as-database tracker rewrite, the Go TUI, localized mode packs, and upstream update-system scaffolding** — they duplicate Turso/the existing dashboard or solve the upstream repositories’ agentic-CLI distribution model, not this board’s needs.

## Current-system findings

1. `functions/api/generate.js` performs JD resolution, two parallel generations, a reviewer, and a repair pass in one Pages request; it should be measured before selecting Queue/`202 + polling`.
2. Current R2 output is Markdown only (`resume.md`, `cover_letter.md`, `job_details.json`); there is no PDF renderer, PDF gate, render-job table, or PDF UI action.
3. Flat keys `materials/<job_id>/...` overwrite prior output and metadata has no JD/profile/template hash.
4. The reuse path reserves `materials_ready` before the reuse lookup completes; a miss can leave a false-ready row. New work needs explicit pending/claimed/succeeded/failed states and leases.
5. Quality results are stored, but hard-blocking versus advisory semantics must be made explicit before PDF rendering.
6. The UI is a daily static snapshot while status mutations live in Turso; a current-status read path is needed before richer lifecycle features.
7. Candidate profile text is embedded in `functions/api/generate.js`; remove the committed PII fallback before broadening intake.

## Data and state contracts

- **Canonical source:** approved generated `resume.md` and `cover_letter.md` in private R2.
- **Version identity:** `version = sha256(normalized_jd + profile_revision + template_revision + renderer_revision)`; use a readable prefix only in paths, never as the sole integrity check.
- **R2 layout:** `materials/<job_id>/versions/<version>/{resume.md,cover_letter.md,job_details.json,manifest.json,resume.pdf,cover_letter.pdf}` plus `materials/<job_id>/current.json`. Keep legacy flat keys readable during migration and never silently overwrite a prior version.
- **Turso:** add idempotent tables for `material_versions` and `render_jobs`; add `generation_jobs` only if the measured latency/error gate requires asynchronous generation. Store version/status/attempts/lease timestamps/error/renderer revision; use conditional claim and terminal updates.
- **Status meanings:** generation/render status is separate from application status. `materials_ready` means source artifacts exist and hard gates pass; render pending/failed must not masquerade as application progression.
- **Security:** keep HMAC binding to job + exact filename + expiry; allow-list PDFs; never put R2 credentials in Pages; renderer reads only fixed local templates and source Markdown, with raw HTML and remote resources disabled.

## Task 1: Freeze contracts and preflight

**Goal:** Publish the evidence matrix and output contract, and add a safe configuration preflight.

**Files:**
- Create: `docs/UPSTREAM-ADOPTION-MATRIX.md`
- Create: `scripts/preflight.mjs`
- Create: `tests/preflight.test.mjs`
- Modify: `README.md`
- Modify: `PLAN-REVIEW-LOG.md`

**Acceptance Criteria:**
- [ ] Matrix identifies each major upstream capability, evidence URL/path, current-board state, adopt/defer/reject decision, and rationale.
- [ ] Output contract records A4/Letter choice, maximum two-page resume, one-page cover letter, Markdown retention, versioning, retention, and failed-render UX.
- [ ] `scripts/preflight.mjs --json` reports missing checks without values of secrets and returns nonzero when required configuration is absent.
- [ ] Documentation no longer claims that Pages is unprovisioned or points to a missing architecture file.

**Verify:** `node --test tests/preflight.test.mjs && node scripts/preflight.mjs --json`; unit tests pass and preflight output is redacted.

## Task 2: Make generation and quality state truthful

**Goal:** Prevent false-ready materials and concurrent overwrites while separating material work state from application status.

**Files:**
- Create: `functions/_lib/material-state.js`
- Create: `tests/material-state.test.mjs`
- Create: `migrations/003_material_lifecycle.sql`
- Modify: `functions/api/generate.js`
- Modify: `functions/api/status.js`
- Modify: `functions/api/applied.js`
- Modify: `functions/_lib/status.js`

**Acceptance Criteria:**
- [ ] Reuse misses, failed generation, failed hard gates, missing objects, and expired leases cannot produce `materials_ready`.
- [ ] Two requests for the same job cannot overwrite a successful current version.
- [ ] Material/generation states are not encoded by mutating application progression; application status transitions remain validated and ledger behavior is explicit.
- [ ] Candidate profile/reference lookup comes from private R2 or fails with a non-PII configuration error.

**Verify:** `node --test tests/material-state.test.mjs tests/status.test.mjs`; orchestration tests prove no false-ready state, no overwrite, and safe claim recovery.

## Task 3: Build deterministic PDF templates and renderer

**Goal:** Convert approved Markdown into safe, polished, ATS-readable resume and cover-letter PDFs on the Pi.

**Files:**
- Create: `templates/resume.ats.html`
- Create: `templates/cover-letter.html`
- Create: `scripts/render-materials.mjs`
- Create: `scripts/materials-renderer.mjs`
- Create: `tests/materials-renderer.test.mjs`
- Create: `tests/fixtures/materials/short.json`
- Create: `tests/fixtures/materials/dense.json`
- Modify: `README.md`

**Acceptance Criteria:**
- [ ] Markdown conversion permits only the intended headings, paragraphs, lists, and emphasis; raw HTML, remote images/fonts/styles, scripts, and links that could trigger fetches are inert or removed.
- [ ] Resume and cover use separate fixed layouts, escaped values, embedded/system fonts, and no unresolved placeholders.
- [ ] Renderer launches Chromium only on local/in-memory content, blocks all requests, and never receives a posting URL.
- [ ] Hard gates verify extracted text, no tofu, no overflow/clipped content/orphan heading, maximum two resume pages, and exactly one cover page before upload.
- [ ] Rendering is deterministic for the same source/template/renderer revision and failed output never replaces a prior good PDF.

**Verify:** `node --test tests/materials-renderer.test.mjs`; on a Pi fixture run `node scripts/render-materials.mjs --fixture tests/fixtures/materials/short.json --dry-run` and verify page counts, extracted text, and zero network requests.

## Task 4: Add render-job handoff and PDF delivery

**Goal:** Process PDF render jobs safely and expose PDF/source downloads without breaking legacy artifacts.

**Files:**
- Create: `scripts/render-jobs.mjs`
- Create: `tests/render-jobs.test.mjs`
- Create: `migrations/004_render_jobs.sql` if not included in Task 2
- Modify: `functions/api/material-links.js`
- Modify: `functions/api/materials/[job_id]/[filename].js`
- Modify: `index.html`
- Modify: `app.js`
- Modify: `style.css`
- Modify: `README.md`

**Acceptance Criteria:**
- [ ] `resume.pdf` and `cover_letter.pdf` are exact allow-listed, signed, private downloads; legacy Markdown links continue to work.
- [ ] Dashboard distinguishes PDF pending, available, and failed states and never presents a missing PDF as available.
- [ ] Pi job claiming uses bounded attempts, exponential backoff, stale-lease recovery, the existing lock convention, and dry-run mode.
- [ ] Handoff initially uses Turso `render_jobs` polled by Pi; a Cloudflare Queue is introduced only if volume or reliability data justifies it.

**Verify:** `node --test tests/render-jobs.test.mjs tests/materials.test.mjs`; production canary confirms both PDFs download with private/no-store/nosniff headers and legacy source links remain available.

## Task 5: Add profile intake and immutable history

**Goal:** Replace the committed profile fallback with confirm-gated private profile revisions and preserve generated artifact history.

**Files:**
- Create: `functions/_lib/profile-manifest.js`
- Create: `scripts/intake-profile.mjs`
- Create: `tests/profile-manifest.test.mjs`
- Modify: `functions/api/generate.js`
- Modify: `functions/api/material-links.js`
- Modify: `index.html`
- Modify: `app.js`
- Modify: `README.md`

**Acceptance Criteria:**
- [ ] Intake supports PDF/text CV and LinkedIn export with `pdftotext -layout` first, requires explicit confirmation before writes, and documents OCR/DOCX as deferred.
- [ ] Private profile/reference objects have stable revisions and hashes; extracted PII is not logged or returned by public routes.
- [ ] Material versions reference the selected profile revision and prior versions remain retrievable.
- [ ] Missing profile data fails visibly and does not silently use a tracked personal fallback.

**Verify:** `node --test tests/profile-manifest.test.mjs`; fixture intake is idempotent, confirm-gated, and redacts extracted personal data from logs.

## Task 6: Add live lifecycle read model and decision support

**Goal:** Reconcile current Turso status with the daily snapshot and surface actionable deadline and fit gates.

**Files:**
- Create: `functions/api/jobs/statuses.js`
- Create: `functions/_lib/knockout.js`
- Create: `tests/jobs-statuses.test.mjs`
- Create: `tests/knockout.test.mjs`
- Modify: `functions/api/_middleware.js`
- Modify: `app.js`
- Modify: `index.html`
- Modify: `style.css`

**Acceptance Criteria:**
- [ ] Authenticated batched status reads are bounded by ID count/response size and override stale snapshot status on load.
- [ ] Deadline status, urgency, repost, and gate have accessible text and filters, including expired/closing-soon views.
- [ ] Knockout extraction only emits warnings for explicit JD evidence and never auto-rejects ambiguous or missing text.

**Verify:** `node --test tests/jobs-statuses.test.mjs tests/knockout.test.mjs`; browser smoke test confirms current status overrides stale JSON.

## Task 7: Add narrowly scoped operations

**Goal:** Make generation and rendering observable, recoverable, and maintainable on the Pi and Pages deployment.

**Files:**
- Create: `scripts/health-report.mjs`
- Create: `tests/health-report.test.mjs`
- Modify: `scripts/check-liveness.mjs`
- Modify: `docs/PHASE2_RUNBOOK.md`
- Modify: `README.md`

**Acceptance Criteria:**
- [ ] Health output reports generation/render latency, failures, reuse, gate, JD-source, stale-lease, and queue-depth summaries without document contents or secrets.
- [ ] Pi renderer timer, lock, dry-run, retry, rollback, and restore operations are documented and tested.
- [ ] Retention runs only after versioned artifacts are live and a restore test proves the current version survives.
- [ ] Interview, offer, salary, and richer follow-up features remain separate future proposals unless a concrete product decision promotes them.

**Verify:** `node scripts/health-report.mjs --self-test`; documented Pi dry-run/lock tests pass; retention cannot delete the current version.

## Execution order and release gate

1. Task 1 fixes decisions and documentation.
2. Task 2 fixes lifecycle correctness before new artifact states are exposed.
3. Task 3 may proceed in parallel with Task 2 after the output contract is fixed.
4. Task 4 is the first user-visible PDF release and depends on Tasks 2–3.
5. Task 5 depends on version identity from Tasks 2–4.
6. Task 6 is independent after current API/auth conventions are confirmed.
7. Task 7 follows the canary and measured behavior.

**Release acceptance:** A selected canary job produces a two-page-maximum resume PDF and one-page cover-letter PDF; extracted text contains the candidate name and required skills; there is no tofu, overflow, or orphan heading; poisoned JD markup causes zero network requests; signed URLs are file-bound and expire; prior versions remain intact; failed rendering is visible and retryable; Markdown remains downloadable; reload reflects Turso status; no automatic submission occurs.

**Skipped:** full provider/plugin/TUI ecosystem, browser autofill, broad integrations, OCR/DOCX/LaTeX, and generalized interview/offer platform. Add each only when a measured user workflow—not upstream parity—requires it.