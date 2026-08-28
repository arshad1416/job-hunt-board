# Plan: Job Hunt Board adoption upgrades
_Locked for implementation and cross-model review_

## Goal
Adopt the highest-value, lowest-risk mechanisms from ai-job-search and career-ops while preserving this project's static-first Cloudflare Pages architecture, truthful resume generation, authenticated material storage, and Pi cron safety.

## Approach
1. Keep Claude Opus 5 via 9Router as the generator and enforce the hermes-skills job-hunter contract.
2. Add deterministic resume facts/ATS/keyword gates, one bounded reviewer pass, one bounded repair pass, and same-employer near-duplicate material reuse.
3. Add an additive Turso status vocabulary and status ledger with follow-up indicators and a bounded follow-up-draft endpoint.
4. Extend the portal with lifecycle filters/statuses, urgency/repost/gate/deadline indicators, follow-up counts, quality feedback, and safe authenticated actions.
5. Extend the Pi pipeline with French/clearance/citizenship veto gates, public ATS ingestion behind an explicit provider allowlist, URL dedupe, deadline extraction, source-health telemetry, and history-preserving expiry handling.
6. Validate with pure unit tests, syntax/import checks, read-only cross-model review, branch/PR merge, production migration/deployment verification, and only then stage job #35 for the user's final Generate click.

## Key decisions & tradeoffs
- Same-employer material reuse only; similar JDs from different employers are never interchangeable.
- Pi ATS board ingestion is opt-in and limited to documented Greenhouse, Lever, and Ashby slugs; the generator also recognizes explicit public detail APIs for Workday and SmartRecruiters, still deriving targets only from validated posting URLs; no arbitrary URLs or LinkedIn guest scraping.
- Quality gates are deterministic and fail-safe; reviewer output is adopted only when its quality rank does not regress.
- Status migration is additive and backed up before production DDL; old clients and jobs.json remain compatible.
- Daily sync may commit only data/jobs.json; source-health remains local to avoid widening automated code commits.
- Follow-up drafts are on-demand, authenticated, bounded, and redact contact details from notes.

## Toolchain
- Claude: job-hunter skill for generation; Cloudflare/Workers guidance for Pages Functions and R2.
- Codex: read-only adversarial review and post-build inspection; no file writes.

## Assumptions
- Production is Cloudflare Pages project job-hunt-board, with source branch main promoted to master.
- Turso uses the existing HTTP v2 parameterized helper and applications table.
- R2 binding JOB_MATERIALS_BUCKET contains the private profile/reference objects and generated materials.
- The Pi is the source of truth for daily job scraping and data/jobs.json generation.
- Job #35 is id 10180, Regional Sales Manager at BYD Canada, score 96, track ev_commercial; no material generation occurs until all reviews/deployment checks pass.

## Risks / open questions
- Public ATS boards require explicit slug configuration and may change response shapes; errors stay non-fatal and are recorded.
- Migration 002 ALTER TABLE statements are additive but not portable/idempotent; backup and preflight are required.
- Production live verification and Pi deployment need the operator's existing credentials and network.

## Out of scope
- Automatic application submission or final Generate click for #35.
- New paid dependencies, arbitrary web crawling, LinkedIn guest scraping, and replacing the existing static-first UI stack.
