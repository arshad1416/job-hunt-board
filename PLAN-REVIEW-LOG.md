# Plan Review Log: Job Hunt Board adoption upgrades

Cross-model review transcript for the locked implementation plan and final diff.

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
