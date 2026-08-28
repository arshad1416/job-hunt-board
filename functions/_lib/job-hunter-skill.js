/* ═══════════════════════════════════════════════════════════════
   job-hunter skill — prompt standards for resume/cover-letter
   generation, distilled from the 'job-hunter' skill
   (hermes-skills repo: profiles/job-hunter/SKILL.md).

   The Worker tailors against the candidate's master profile and a
   same-track reference resume stored privately in R2:
     assets/resume_profile.yaml      — structured two-track master
     assets/master_resume_ev.md      — EV Commercial reference
     assets/master_resume_ai.md      — AI/Engineering reference
   ═══════════════════════════════════════════════════════════════ */

/** R2 key for the structured master profile. */
export const PROFILE_KEY = 'assets/resume_profile.yaml';

/** Track -> reference resume key in R2. */
export function trackReferenceKey(track) {
  const t = String(track || '').toLowerCase();
  if (t === 'ai_engineering' || t === 'ai') return 'assets/master_resume_ai.md';
  // ev_commercial and general default to the EV reference (primary track).
  return 'assets/master_resume_ev.md';
}

/** Core truthfulness mission, verbatim intent from the skill. */
export const MISSION = `MISSION: land interviews with strong, honest, tailored applications.
Truthful only — NEVER fabricate experience, titles, employers, dates,
metrics, or credentials. Every claim must be grounded in the master
profile or reference resume. Silence is better than invention.`;

/** ATS-safe resume structure the skill mandates (docx-convertible markdown). */
export const RESUME_STANDARDS = `RESUME OUTPUT STANDARDS (ATS — applicant tracking systems):
- First line: name alone. Subtitle line below it (target title for THIS
  role). Do NOT fuse name and title with an em-dash or pipe.
- Contact block in body text near the top (never a markdown table).
- Section headers, exactly these standard names, in this order:
  PROFESSIONAL SUMMARY, SKILLS, PROFESSIONAL EXPERIENCE, EDUCATION
- Reverse-chronological order. Dates as MM/YYYY consistently.
- Bullets follow: action verb + what you did + how + quantified result.
- SKILLS section mirrors the exact tools/phrasing of the job description.
- Single-column conventions in Markdown: '##' sections, '###' job entries,
  '-' bullets, '**' bold — NO tables, NO links, NO images (the output is
  converted to styled .docx by the job-hunter converter afterwards).
- One page when converted. Ruthlessly concise.`;

/** Cover letter structure the skill mandates. */
export const COVER_LETTER_STANDARDS = `COVER LETTER STANDARDS:
- 250-300 words maximum, one page, 3-4 paragraphs:
  1. The role + a quick, specific connection to it (why this role/company)
  2. One key achievement with metrics, matched to the posting's core need
  3. The differentiator — what makes this candidate unusual for THIS role
  4. Call to action + professional closing
- Same voice as the resume. Markdown-lite only ('**' bold allowed, no
  links, no tables) so the job-hunter converter can produce the .docx.`;
