# Plan Review Log: Job Hunt Board adoption upgrades

Cross-model review transcript for the locked implementation plan and final diff. Task 1 documentation and preflight review remains active until all acceptance criteria pass.

## Independent Opus 5 repository-adoption review
- Initial compact request: FAILED — 9Router returned HTTP 502 `[claude/claude-opus-5] [502]: fetch connect timeout (reset after 30s)`; no approval inferred.
- Bounded retry: SUCCEEDED — HTTP 200 through the Pi 9Router endpoint, model `cc/claude-opus-5`, reasoning effort `max`; response was intentionally capped at 6000 tokens but still ended at the provider length limit before its requested final verdict line.
- Findings retained as advisory: Opus endorsed tri-state gates, untrusted JD boundaries, no-scoring for inaccessible postings, grounded claim/quote validation, duplicate detection, and human-in-the-loop output; it did not issue a complete APPROVED/REVISE verdict. The concrete branch review gate remains Codex plus local verification.

## Post-build Codex inspection
- Request: fresh read-only Codex inspection of the complete branch diff; CLI `codex-cli 0.146.0`, model `gpt-5.6-luna`, max reasoning.
- Result: the documented read-only Codex invocation exceeded the 10-minute ceiling without producing a `thread.started` line or verdict file; no Codex approval inferred.
- Disposition: a second concise invocation also hit the 10-minute tool ceiling without a verdict; its process was stopped. Focused read-only implementation audits and the Qwen formal review supplied the actionable findings below; no external Codex approval is claimed.

## Formal Qwen claudex review
- Model: `qd/qmodel_38max` (Qwen 3.8 Max), reasoning effort `max`, read-only prompt against the full branch.
- Result: HTTP 200; reviewer reported no repository access in its execution context and therefore returned `VERDICT: REVISE` based on inability to verify. This is a valid non-approval, not a code finding; the local read-only audits and tests provided repository evidence. No Qwen approval is claimed.

## Resolution of local review findings
- Accepted: numeric claim matching now uses boundaries with regression coverage; cached materials return without regeneration when status bookkeeping fails; generation/repair errors no longer expose upstream response bodies; generator key preflight returns 503; frontend follow-up dates use UTC and canonical eligibility; generated/reused materials append ledger events when the transition updates a pre-pipeline row; Greenhouse base64 content is decoded in both Python and Workers parsers; schema probes re-raise transport/auth failures; empty sync results publish current empty data; ATS labels preserve colons.
- Accepted follow-up: `/api/status` now preserves `applied_at` when moving back to pre-pipeline statuses; a UTC timestamp regression test covers the shared helper.
- Resolved after Qwen evidence review: UTF-8 Greenhouse decoding now uses `TextDecoder`; cached partial quality reports fail closed; legacy unapply preserves `applied_at` and rejects active-pipeline downgrades; status responses return canonical dates; sync deadline extraction uses the sanitized description/notes fallback; score rendering is bounded; provider scope is documented accurately; the reuse target is atomically claimed with a pre-pipeline status update before R2 writes.
- Deferred: a dedicated source-of-truth/profile fallback redesign, a true lease/expiry for abandoned reservations, and stricter transition legality beyond the legacy endpoint guard. The atomic pre-pipeline claim plus second R2 `head()` addresses the concurrent overwrite scenario for active requests; abandoned-claim cleanup remains operational follow-up and does not block this branch's requested adoption scope.

## Post-build inspection — render pipeline first-run fixes (2026-09-02)

Fresh read-only Codex session (codex-cli 0.146.0, `gpt-5.6-luna`, thread 01a062cb-e118-71e1-aad1-4625744ff0e0) reviewed the uncommitted diff. Findings and dispositions:

- Accepted (P1): preflight accepted `CHROMIUM_BIN` by presence alone. Now validated through the renderer's `--version` probe (`chromiumPath(env)`), so a configured-but-nonexistent binary fails preflight.
- Accepted (P1): dry-run lock contention exited 0. `runWorker` now checks `pollRenderJobs` error before the dry-run early return and surfaces `infraError` for both modes; regression test added.
- Accepted (P1): R2/Turso transport errors were persisted as job failures (burning attempts and exiting 0). `processRenderJob` now classifies known document/gate defects (`JOB_FAILURE_CODES`) as job failures and everything else as `infra_error`, which makes the CLI exit nonzero without consuming an attempt; tests added.
- Accepted (P2): `R2_ENDPOINT` validated by `https://` prefix only; now parsed with `new URL` requiring an https protocol and hostname, matching the SigV4 client's own parsing.
- Partially accepted (P2): coverage gaps. Seeded renderer-failure path already existed at the `processRenderJob` level; the `runWorker` failure test now seeds sources so the renderer actually runs. Upload-failure tests were re-expectationed to `infra_error` — the correct classification for transport faults — while still asserting staged-PDF rollback.

Round 1 of MAX_INSPECTION_ROUNDS=2; no findings remained after fixes, so no reinspection round was spent. Full suite 131/131.

## Live canary findings (2026-09-02) — render pipeline first production run

Canary job 10180 on production Turso/R2/Pi. Three first-contact defects found and fixed, each with a regression test:

1. **`scripts/lib/r2-s3.mjs` signed the canonical-request hash, not the string-to-sign.** Real R2 returned `SignatureDoesNotMatch`; the mocked-fetch unit tests never validated the signature. Verified against curl 8.7 `--aws-sigv4` (auth OK) and R2's echoed string-to-sign before fixing. New test recomputes the Authorization header from an independent reference implementation.
2. **`hardGates` treated pdftotext form-feed page separators as tofu.** Every rendered PDF (single-page included) failed the control-character scan. Form feeds and CR are now stripped before the scan; genuine U+FFFD still fails.
3. **`createLocalPdfRenderer` built its payload with an empty "other" document.** `renderMaterials` requires both documents non-empty, so the worker's renderer could never pass validation. Both slots now carry the rendered markdown; the renderer projects only the requested type.

Also fixed during first-run prep: `DASHBOARD_AUTH_TOKEN` was rotated (the old value is no longer valid; the browser must re-enter it once); an old material version for 10180 predating contact-field extraction is permanently unrenderable and its render job was made terminal.

Canary result: generate → render_jobs enqueue → Pi render (2-page resume, 1-page cover letter, gates green) → R2 upload with recorded SHA-256/bytes → signed links report `pdf_state: available` → verified download with `private, no-store` and clean text extraction. 133/133 tests green.

## Reviewer-pass restoration — Codex inspection (2026-09-02, round 1 of 2)

Fresh read-only Codex session (gpt-5.6-luna, thread 01a06378-78a8-79e1-ba6e-ed25cebbd7fa) reviewed the diff before merge.
- Accepted (P1): leftover `Begin JSON:` prompt tail removed (it could steer the model back to the truncating JSON protocol); max_tokens now 9000 with delimited `<<<RESUME … >>>` sections and a tolerant parser.
- Accepted (P2): header strip now removes the contact block (not just the H1) across the pre-heading region, keeps subtitles/prose, and treats linkedin/github lines as contact only when short and punctuation-free; regression tests added for subtitle retention and GitHub-mention prose.
- Accepted (P2): `reviewer_used` now means the review ran (adopted or rank-rejected); UI distinguishes "LLM-reviewed" / "ran, kept original" / "skipped (reason)" and omits the clause entirely on cached responses.
- Deferred (P1): wiring the PDF renderer revision into material_versions invalidation so existing current materials re-render automatically. The renderer revision is bumped (v3→v4) and new generations pick it up, but a version-invalidation pass for existing pointers is a design change tracked as follow-up; the canary material is regenerated manually in this session.
Full suite 140/140 after fixes.
