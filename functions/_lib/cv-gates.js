/* ═══════════════════════════════════════════════════════════════
   cv-gates.js — deterministic quality gates for generated documents.

   Ported and adapted for Markdown output from two MIT sources:
   - career-ops verify-cv-facts.mjs / verify-ats.mjs (fabrication +
     parseability gates)
   - ai-job-search apply.md factual grounding audit

   Pure, dependency-free (Workers-safe), deterministic: no LLM, no
   network. /api/generate runs these gates on every generated
   document BEFORE it is written to R2, so the job-hunter skill's
   "truthful-only, ATS-clean" rules are enforced mechanically
   rather than trusted to the prompt.
   ═══════════════════════════════════════════════════════════════ */

/* ── 1. Claim extraction ────────────────────────────────────────── */

/** Nouns that turn a bare number into a falsifiable experience claim. */
const METRIC_NOUNS = new Set([
  'user', 'customer', 'client', 'account', 'dealer', 'dealership',
  'store', 'location', 'market', 'region', 'province', 'state',
  'country', 'team', 'engineer', 'person', 'people', 'report',
  'hire', 'project', 'release', 'deploy', 'ticket', 'lead', 'leads',
  'partner', 'vendor', 'supplier', 'sku', 'unit', 'vehicle', 'car',
  'order', 'franchise', 'technician', 'manager', 'revenue', 'dollar',
  'cost', 'saving', 'hour', 'day', 'week', 'month', 'year', 'mile',
  'km', 'percent', 'point', 'application', 'deployment', 'interview',
  'candidate', 'student', 'training', 'workshop', 'campaign',
  'launch', 'program', 'initiative',
]);

/** Number words accepted in source documents (eight == 8). */
const WORD_NUMBERS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  // hundred/thousand/million/billion deliberately absent: the money-squash
  // regexes below own those scales (converting them here too would turn
  // "twenty million" into "20 1000000" and break claim matching).
};

/** Normalize a text blob for claim matching (both sides get this). */
function normalizeText(text) {
  let t = String(text || '').toLowerCase();
  // number words: "eight years" -> "8 year"
  t = t.replace(/[a-z]+/g, (w) => {
    const n = WORD_NUMBERS[w];
    return n === undefined ? w : String(n);
  });
  // money/quantity: $20M, 20 million, $20,000,000 -> 20m
  t = t.replace(/\$\s?([\d,.]+)\s?billion\b/g, '$1b');
  t = t.replace(/\$\s?([\d,.]+)\s?million\b/g, '$1m');
  t = t.replace(/\$\s?([\d,.]+)\s?thousand\b/g, '$1k');
  t = t.replace(/([\d,.]+)\s?million\b/g, '$1m');
  t = t.replace(/([\d,.]+)\s?billion\b/g, '$1b');
  t = t.replace(/\$\s?([\d,.]+)\s?m\b/g, '$1m');
  t = t.replace(/\$\s?([\d,.]+)\s?k\b/g, '$1k');
  t = t.replace(/\$\s?([\d,.]+)\s?b\b/g, '$1b');
  t = t.replace(/\$/g, '');
  t = t.replace(/[,]/g, '');
  // Plus signs express the same quantity in claims such as 8+ years
  // and 8 years; discard the annotation rather than making a false mismatch.
  t = t.replace(/\+/g, '');
  t = t.replace(/[\u2013\u2014\u2212]/g, '-');
  t = t.replace(/[\u2018\u2019]/g, "'");
  t = t.replace(/[\u201C\u201D]/g, '"');
  t = t.replace(/\s+/g, ' ');
  // naive plural strip so "8 years" matches claim "8 year"
  t = t.replace(/\b([a-z]{4,})s\b/g, '$1');
  return t;
}

/** Normalize one extracted claim string the same way. */
function normalizeClaim(claim) {
  return normalizeText(claim).trim();
}

/**
 * Extract falsifiable quantity claims from a generated document.
 * Four claim shapes: money, percent, multipliers, number+metric-noun.
 * @returns {Array<{claim: string, kind: string}>}
 */
function extractClaims(text) {
  const src = String(text || '');
  const found = [];
  const push = (claim, kind) => { if (claim) found.push({ claim: claim.trim(), kind }); };

  // money: $20M, $1.2 billion, $15,000
  for (const m of src.matchAll(/\$\s?\d[\d,.]*\s?(?:billion|million|thousand|b|m|k)?\b/gi)) {
    push(m[0], 'money');
  }
  // percent: 30%, 12.5 %
  for (const m of src.matchAll(/\b\d[\d,.]*(?:\.\d+)?\s?%/g)) {
    push(m[0], 'percent');
  }
  // multipliers: 3x, 2.5x
  for (const m of src.matchAll(/\b\d[\d,.]*(?:\.\d+)?\s?[x\u00d7]\b/gi)) {
    push(m[0], 'multiplier');
  }
  // number + metric noun ("8+ years", "12 dealerships", "$0 to $20M")
  for (const m of src.matchAll(/\b(\d[\d,.]*(?:\.\d+)?)\s*(?:of\s+)?([a-z]+)\b/gi)) {
    const noun = m[2].toLowerCase().replace(/s$/, '');
    if (METRIC_NOUNS.has(noun)) push(m[1] + ' ' + noun, 'count');
  }
  return found;
}

/**
 * Factual grounding audit: every claim in the generated documents
 * must be traceable to the union of the source documents (master
 * profile + reference resume). Employer JD numbers are deliberately
 * NOT sources: the posting's numbers belong to the employer.
 */
function verifyFacts({ generated, sources }) {
  const union = normalizeText(sources.filter(Boolean).join('\n'));
  const claims = extractClaims(generated);
  const violations = [];
  for (const { claim, kind } of claims) {
    const needle = normalizeClaim(claim);
    if (!needle) continue;
    // Match token boundaries so 8 does not pass against 18 and 20m does not
    // pass against 120m. The normalized claim may contain spaces/punctuation.
    const escaped = needle.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const exact = new RegExp('(^|[^a-z0-9])' + escaped + '(?![a-z0-9])');
    if (!exact.test(union)) violations.push({ claim, kind });
  }
  return { ok: violations.length === 0, checked: claims.length, violations };
}

/* ── 2. ATS structural score ────────────────────────────────────── */

const REQUIRED_SECTIONS = [
  { key: 'summary', re: /professional summary|summary/ },
  { key: 'skills', re: /skills/ },
  { key: 'experience', re: /professional experience|experience/ },
  { key: 'education', re: /education/ },
];

/**
 * Score a Markdown resume for ATS parseability, 0-100, with an
 * auditable breakdown (career-ops verify-ats weight table adapted
 * for the Markdown pipeline: section + text checks replace the
 * PDF font checks).
 */
function atsScore(resumeMd) {
  const md = String(resumeMd || '');
  const lines = md.split('\n');
  const checks = [];
  const add = (key, weight, got, detail) => checks.push({ key, weight, got, detail });

  // sections (20): name-alone first line + the four skill headers
  const firstLine = (lines.find((l) => l.trim().length > 0) || '').trim();
  const nameOk = /^[A-Za-z][A-Za-z .,'''-]{1,60}$/.test(firstLine) && firstLine.split(/\s+/).length >= 2;
  const headers = lines
    .filter((l) => /^#{1,4}\s+/.test(l))
    .map((l) => l.replace(/^#{1,4}\s+/, '').trim().toLowerCase());
  let sectionGot = nameOk ? 4 : 0;
  const sectionDetail = [nameOk ? 'name-alone first line' : 'first line is not a plain name'];
  for (const sec of REQUIRED_SECTIONS) {
    if (headers.some((h) => sec.re.test(h))) { sectionGot += 4; sectionDetail.push(sec.key + ' ok'); }
    else sectionDetail.push(sec.key + ' MISSING');
  }
  add('sections', 20, sectionGot, sectionDetail.join('; '));

  // dates (10): MM/YYYY present when an experience section exists
  const hasExperience = headers.some((h) => /experience/.test(h));
  const dateCount = (md.match(/\b(0?[1-9]|1[0-2])\/\d{4}\b/g) || []).length;
  if (!hasExperience) add('dates', 10, 10, 'no experience section; date check skipped');
  else if (dateCount >= 2) add('dates', 10, 10, dateCount + ' MM/YYYY dates');
  else if (dateCount === 1) add('dates', 10, 5, 'only one MM/YYYY date found');
  else add('dates', 10, 0, 'no MM/YYYY dates (skill standard requires them)');

  // quantified bullets (15): share of bullets carrying a number
  const bullets = lines.filter((l) => /^\s*-\s+/.test(l));
  if (bullets.length === 0) {
    add('quantified', 15, 0, 'no dash bullets found');
  } else {
    const quantified = bullets.filter((b) => /\d/.test(b)).length;
    const ratio = quantified / bullets.length;
    add('quantified', 15, ratio >= 0.5 ? 15 : ratio >= 0.3 ? 8 : 0,
      quantified + '/' + bullets.length + ' bullets quantified');
  }

  // contact (15): email + phone
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(md);
  const phone = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(md);
  add('contact', 15, email && phone ? 15 : email || phone ? 8 : 0,
    (email ? 'email ok' : 'email missing') + ', ' + (phone ? 'phone ok' : 'phone missing'));

  // tables (8): markdown tables scramble in ATS text layers
  const hasTable = /^\s*\|.*\|\s*$/m.test(md);
  add('tables', 8, hasTable ? 0 : 8, hasTable ? 'markdown table found' : 'no tables');

  // html (5)
  const hasHtml = /<\/?[a-z][a-z0-9]*[^>]*>/i.test(md);
  add('html', 5, hasHtml ? 0 : 5, hasHtml ? 'html tags found' : 'no html');

  // images (7)
  const hasImage = /!\[[^\]]*\]\([^)]*\)|<img\b/i.test(md);
  add('images', 7, hasImage ? 0 : 7, hasImage ? 'image embed found' : 'no images');

  // raw markdown links (5): the URL is lost in plain text
  const hasLinks = /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(md);
  add('links', 5, hasLinks ? 0 : 5, hasLinks ? 'markdown links found (print plain URLs instead)' : 'no raw markdown links');

  // charset (10): smart quotes, nbsp, zero-width
  const badChars = md.match(/[\u2018\u2019\u201C\u201D\u00A0\u200B\uFEFF]/g) || [];
  add('charset', 10, badChars.length === 0 ? 10 : badChars.length <= 3 ? 5 : 0,
    badChars.length === 0 ? 'ascii-safe punctuation' : badChars.length + ' smart/zero-width chars');

  // hidden text (5): comments, zero-width
  const hidden = /<!--[\s\S]*?-->|[\u200B\uFEFF]/.test(md);
  add('hidden', 5, hidden ? 0 : 5, hidden ? 'hidden text pattern found' : 'no hidden text');

  const score = checks.reduce((sum, c) => sum + c.got, 0);
  return { score, checks };
}

/* ── 3. Keyword coverage (the honesty table) ────────────────────── */

const STOPWORDS = new Set((
  'the a an and or but with without for from to of in on at by as is are was were be been being ' +
  'this that these those you your our their they it its will would can could should shall may ' +
  'must have has had do does did not no yes if then than so such about into over under again ' +
  'other more most some any each every all both few many much very using use used new seek seeking ' +
  'join team company role job position candidate ideal plus strong ability across while who whom ' +
  'which what when where why how also based including includes include well etc via per theirs ' +
  'years experience work working works'
).split(/\s+/));

/** Tokenize text into lowercase words, plural-stripped, len >= 3. */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.#+-]+|[.#+-]+$/g, ''))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => (w.endsWith('s') && w.length > 4 ? w.slice(0, -1) : w));
}

/**
 * Build the keyword honesty table for a generated resume against the
 * posting and the master source documents (ai-job-search apply.md
 * 4-state table, reduced to 3 verifiable states):
 *  - covered: keyword (or plural stem) appears in the resume
 *  - have:    absent from resume but present in the master profile
 *  - gap:     in neither resume nor profile — never stuff keywords;
 *             this is a genuine development area, surfaced honestly
 */
function keywordCoverage(resumeMd, jdText, profileText) {
  const resumeTokens = new Set(tokenize(resumeMd));
  const profileTokens = new Set(tokenize(profileText));
  const jdTokens = tokenize(jdText);

  const freq = new Map();
  for (const t of jdTokens) freq.set(t, (freq.get(t) || 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([w]) => w);

  const entries = top.map((kw) => ({
    keyword: kw,
    state: resumeTokens.has(kw) ? "covered" : profileTokens.has(kw) ? "have" : "gap",
  }));

  const covered = entries.filter((e) => e.state === "covered").length;
  const have = entries.filter((e) => e.state === "have").length;
  const gap = entries.filter((e) => e.state === "gap").length;
  return {
    entries,
    covered,
    have,
    gap,
    coverageRate: entries.length ? Math.round((covered / entries.length) * 100) : 100,
  };
}

/* ── 4. JD similarity (reuse verdicts) ──────────────────────────── */

/** Jaccard similarity between two token arrays. */
function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 64-bit simhash over 3-token shingles (career-ops fingerprint-core
 * pattern) for near-duplicate JD detection across listings.
 * @returns {string} 16-hex characters
 */
function simhash64(text) {
  const tokens = tokenize(text);
  const shingles = [];
  for (let i = 0; i + 3 <= tokens.length; i++) shingles.push(tokens.slice(i, i + 3).join(" "));
  if (shingles.length === 0) return "0".repeat(16);

  const bits = new Array(64).fill(0);
  for (const sh of shingles) {
    let h = 0xcbf29ce484222325n; // FNV-1a 64 offset basis
    for (let i = 0; i < sh.length; i++) {
      h ^= BigInt(sh.charCodeAt(i));
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    for (let b = 0; b < 64; b++) {
      bits[b] += (h >> BigInt(b)) & 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) {
    if (bits[b] > 0) out |= 1n << BigInt(b);
  }
  return out.toString(16).padStart(16, "0");
}

/** Hamming distance between two 16-hex simhash fingerprints. */
function hammingDistance(hexA, hexB) {
  const a = BigInt("0x" + (hexA || "0").padStart(16, "0"));
  const b = BigInt("0x" + (hexB || "0").padStart(16, "0"));
  let x = a ^ b;
  let count = 0;
  while (x) { count += Number(x & 1n); x >>= 1n; }
  return count;
}

/**
 * Reuse verdict for a new JD against an already-generated one
 * (career-ops jd-similarity thresholds).
 */
function reuseVerdict(jdAText, jdBText) {
  const sim = jaccard(tokenize(jdAText), tokenize(jdBText));
  if (sim >= 0.72) return "reuse";
  if (sim >= 0.45) return "edit";
  return "regenerate";
}

/**
 * Convenience wrapper: run every gate and return the object that is
 * stored inside job_details.json.
 */
function buildQualityReport({ resumeMd, coverMd, jdText, profileText, referenceText, atsMin = 70 }) {
  // Candidate facts are a hard gate on the resume. Cover letters may
  // repeat employer-owned figures from the JD (for example, fleet size),
  // so keep their audit visible but do not mistake those figures for
  // fabricated candidate history.
  const facts = verifyFacts({ generated: resumeMd, sources: [profileText, referenceText] });
  const coverFacts = verifyFacts({ generated: coverMd, sources: [profileText, referenceText] });
  const ats = atsScore(resumeMd);
  const coverage = keywordCoverage(resumeMd, jdText, profileText);
  return {
    facts,
    coverFacts,
    ats,
    atsPass: ats.score >= atsMin,
    atsMin,
    keywordCoverage: coverage,
  };
}

export {
  METRIC_NOUNS,
  WORD_NUMBERS,
  normalizeText,
  normalizeClaim,
  extractClaims,
  verifyFacts,
  atsScore,
  REQUIRED_SECTIONS,
  keywordCoverage,
  tokenize,
  jaccard,
  simhash64,
  hammingDistance,
  reuseVerdict,
  buildQualityReport,
};
