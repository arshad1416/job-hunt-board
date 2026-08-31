# Upstream Adoption Matrix

This matrix records the evidence used for the selective, safety-first adoption plan. Upstream code is reference material, not a dependency or wholesale import.

| Capability | Evidence | Board state | Decision | Rationale |
|---|---|---|---|---|
| ATS-safe deterministic PDF output | https://github.com/MadsLorentzen/ai-job-search (LaTeX/Python helpers); local functions/_lib/cv-gates.js | Markdown only; gates exist | Adopt | Deterministic rendering and extracted-text gates are testable and preserve truthfulness. |
| Fixed resume/cover templates | https://github.com/MadsLorentzen/ai-job-search (template helpers); docs/UPSTREAM-ADOPTION-PLAN.md Task 3 | Not present | Adopt | Fixed layouts reduce layout drift and injection risk. |
| Immutable artifact versions | docs/UPSTREAM-ADOPTION-PLAN.md Data and state contracts | Flat R2 keys currently overwrite | Adopt | Hash-keyed versions preserve rollback and auditability. |
| Evidence-grounded fact checks | functions/_lib/cv-gates.js, functions/_lib/generation-quality.js | Present | Adopt | Retain existing correctness seam; do not infer candidate facts. |
| Confirm-before-write profile intake | docs/UPSTREAM-ADOPTION-PLAN.md § Adopt | Embedded fallback remains | Adopt | Private, explicitly confirmed revisions avoid silent PII changes. |
| Live lifecycle/status reconciliation | functions/api/status.js, functions/_lib/status.js | Status mutations exist; snapshot is stale | Adopt | Current status must override discovery data. |
| Broad provider scanner (~90 boards) | https://github.com/santifer/career-ops; docs/UPSTREAM-ADOPTION-PLAN.md § Deferred | Narrow existing providers | Defer | Add only for measured user demand; avoid maintenance and scope sprawl. |
| OCR/DOCX/LaTeX intake | docs/UPSTREAM-ADOPTION-PLAN.md § Deferred | PDF/text scope | Defer | Native PDF/text path is sufficient for the first safe slice. |
| Automatic submission/autofill | docs/UPSTREAM-ADOPTION-PLAN.md § Rejected | Not present | Reject | Irreversible browser actions violate human-in-the-loop safety. |
| Plugins and third-party integrations | docs/UPSTREAM-ADOPTION-PLAN.md § Rejected | Not present | Reject | Avoid OAuth, supply-chain, and privacy scope without a requirement. |
| Chromium in Cloudflare | docs/UPSTREAM-ADOPTION-PLAN.md § Rejected | Not present | Reject | Rendering belongs on the isolated Pi; never fetch untrusted JD resources. |

## Output contract

- Page size: A4 initially (renderer must make the choice explicit and version it).
- Resume: maximum two pages; cover letter: exactly one page.
- Canonical sources remain approved Markdown in private R2; PDFs are derived artifacts.
- Every material version is identified by a SHA-256 identity over normalized JD, profile revision, template revision, and renderer revision.
- Failed renders never replace a prior successful version; the UI reports pending/failed/available distinctly.
- Legacy Markdown remains downloadable during migration; retention must never remove the current version.
