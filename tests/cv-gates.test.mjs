import assert from 'node:assert/strict';
import test from 'node:test';

import {
  atsScore,
  buildQualityReport,
  extractClaims,
  hammingDistance,
  jaccard,
  keywordCoverage,
  normalizeText,
  reuseVerdict,
  simhash64,
  tokenize,
  verifyFacts,
} from '../functions/_lib/cv-gates.js';

const PROFILE = `
name: Arshad Kazi
summary: EV commercial leader with 8 years in dealer network development.
Scaled revenue from $0 to $20M+ across Ontario and Eastern Canada.
Built training programs for 120 dealership staff.
`;

const MASTER = `
# Arshad Kazi
## PROFESSIONAL EXPERIENCE
### Regional Sales Lead - EV Market Entry (01/2020 - 12/2024)
- Scaled revenue from $0 to $20M+ by building dealer networks across Ontario.
- Trained 120 dealership staff on EV retail operations.
- Grew regional market share by 30% in two years.
`;

test('normalizeText squashes money and number words on both sides', () => {
  assert.equal(normalizeText('$20M'), normalizeText('twenty million'));
  assert.equal(normalizeText('$1.5B'), normalizeText('1.5 billion'));
  assert.equal(normalizeText('8 years'), normalizeText('eight year'));
  assert.ok(normalizeText('$0 to $20M+').includes('20m'));
});

test('extractClaims finds the four claim shapes', () => {
  const claims = extractClaims('Grew $20M revenue, cut 30% cost, delivered 3x throughput, led 12 dealers.');
  const kinds = Object.fromEntries(claims.map((c) => [c.claim.toLowerCase(), c.kind]));
  assert.equal(kinds['20m'] || kinds['$20m'], 'money');
  assert.equal(kinds['30%'], 'percent');
  assert.equal(kinds['3x'], 'multiplier');
  const count = claims.find((c) => c.kind === 'count');
  assert.ok(count, 'count claim missing');
  assert.match(count.claim, /^12 dealers?$/i);
});

test('verifyFacts passes grounded claims and flags invented ones', () => {
  const sources = [PROFILE, MASTER];
  const grounded = verifyFacts({ generated: 'Scaled revenue to $20M over 8 years.', sources });
  assert.equal(grounded.ok, true);
  const invented = verifyFacts({ generated: 'Delivered 40% cost savings and managed 500 users.', sources });
  assert.equal(invented.ok, false);
  assert.ok(invented.violations.some((v) => v.claim.includes('40')));
  assert.ok(invented.violations.some((v) => v.claim.includes('500')));
});

test('verifyFacts does not accept numeric substrings as grounded claims', () => {
  const sources = ['Managed 18 years of dealer operations and grew revenue to $120M.'];
  const result = verifyFacts({ generated: 'Managed 8 years and grew revenue to $20M.', sources });
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 2);
});

test('verifyFacts treats employer JD numbers as non-sources', () => {
  // The generate endpoint passes ONLY candidate documents as sources.
  // Even though the JD mentions $2B, it is not a source, so the claim
  // must be flagged.
  const res = verifyFacts({
    generated: 'Owned a $2B product line.',
    sources: [PROFILE, MASTER],
  });
  assert.equal(res.ok, false, 'JD numbers must not validate candidate claims');
});

const GOOD_RESUME = [
  '# Arshad Kazi',
  'Toronto, Ontario | arshad@example.com | +1 416 555 0123',
  '',
  '## PROFESSIONAL SUMMARY',
  'EV commercial leader with 8 years in dealer network development.',
  '',
  '## SKILLS',
  'Dealer network development, EV go-to-market, KPI management',
  '',
  '## PROFESSIONAL EXPERIENCE',
  '### Regional Sales Lead (01/2020 - 12/2024)',
  '  - Scaled revenue from $0 to $20M+ across Ontario.',
  '  - Trained 120 dealership staff on EV retail operations.',
  '  - Grew market share by 30% in two years.',
  '',
  '## EDUCATION',
  'BComm, University of Toronto',
].join('\n');

test('atsScore rewards a clean skill-standard resume', () => {
  const { score, checks } = atsScore(GOOD_RESUME);
  assert.ok(score >= 90, 'expected >= 90, got ' + score + ': ' + JSON.stringify(checks));
});

test('atsScore penalizes tables, links, images and smart quotes', () => {
  const bad = [
    'Arshad Kazi',
    '‘quotes’ and a table below',
    '| col1 | col2 |',
    '| ---- | ---- |',
    '| a    | b    |',
    '[my site](https://example.com)',
    '![logo](https://example.com/x.png)',
    '<b>bold</b>',
    '## EXPERIENCE',
    '  - did things without numbers',
    '  - more of the same',
  ].join('\n');
  const { score } = atsScore(bad);
  assert.ok(score <= 55, 'expected <= 55, got ' + score);
});

test('keywordCoverage classifies covered / have / gap', () => {
  const jd = 'We need dealer network development, charger infrastructure rollout, and SAP inventory experience.';
  const resume = 'Dealer network development across Ontario.';
  const profile = 'Deep background in charger infrastructure pilots.';
  const cov = keywordCoverage(resume, jd, profile);
  const byKw = Object.fromEntries(cov.entries.map((e) => [e.keyword, e.state]));
  assert.equal(byKw['dealer'], 'covered');
  assert.equal(byKw['charger'], 'have');
  assert.equal(byKw['sap'], 'gap');
  assert.ok(cov.coverageRate > 0 && cov.coverageRate < 100);
});

test('simhash distance separates near-duplicates from different JDs', () => {
  const a = 'Regional sales manager responsible for dealer network development across Ontario, EV go-to-market strategy, quarterly business reviews with dealer principals, and retail KPI accountability across the region. The role also owns inventory planning, vehicle allocation, new model launch execution, and corrective action plans for underperforming stores.';
  const b = 'Regional sales manager responsible for dealer network growth across Ontario, EV go-to-market strategy, quarterly business reviews with dealer principals, and retail KPI accountability across the region. The role also owns inventory planning, vehicle allocation, new model launch execution, and corrective action plans for underperforming stores.';
  const c = 'Seeking a registered nurse for the emergency ward. Shift work includes nights and weekends. CPR certification required for all clinical staff.';
  assert.ok(hammingDistance(simhash64(a), simhash64(b)) <= 12, 'near-duplicates should be close');
  assert.ok(hammingDistance(simhash64(a), simhash64(c)) >= 20, 'different JDs should be far');
});

test('reuseVerdict applies career-ops thresholds', () => {
  const a = tokenize('dealer network development EV strategy KPI reviews inventory planning training programs');
  assert.equal(reuseVerdict(a.join(' '), a.join(' ')), 'reuse');
  const b = tokenize('dealer network development EV strategy KPI reviews');
  assert.ok(['reuse', 'edit'].includes(reuseVerdict(a.join(' '), b.join(' '))));
  assert.equal(reuseVerdict(a.join(' '), 'registered nurse emergency ward night shifts'), 'regenerate');
  assert.ok(jaccard(a, a) === 1);
});

test('buildQualityReport wires every gate together', () => {
  const rep = buildQualityReport({
    resumeMd: GOOD_RESUME,
    coverMd: 'I am excited about the role at BYD Canada. My $20M revenue scale-up matches your goals.',
    jdText: 'Regional sales manager for EV dealer network across Canada. Charger infrastructure experience preferred.',
    profileText: PROFILE,
    referenceText: MASTER,
  });
  assert.equal(typeof rep.ats.score, 'number');
  assert.equal(rep.atsPass, rep.ats.score >= rep.atsMin);
  assert.ok(rep.facts.checked >= 2);
  assert.ok(Array.isArray(rep.keywordCoverage.entries));
});
