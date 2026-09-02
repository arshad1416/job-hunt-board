import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REUSE_SIMILARITY_THRESHOLD,
  REUSE_SCAN_LIMIT,
  MAX_REVIEW_DOCUMENT_CHARS,
  buildQualityReport,
  cleanDocument,
  closestReusableJob,
  parseReviewerResponse,
  qualityRank,
  reusableQuality,
  sameEmployer,
} from '../functions/_lib/generation-quality.js';

test('constants stay within their documented budgets', () => {
  assert.equal(REUSE_SIMILARITY_THRESHOLD, 0.72);
  assert.equal(REUSE_SCAN_LIMIT, 150);
  assert.ok(MAX_REVIEW_DOCUMENT_CHARS > 0 && MAX_REVIEW_DOCUMENT_CHARS < 100000);
});

test('cleanDocument strips markdown code fences', () => {
  assert.equal(cleanDocument('```markdown\n# Resume\n```'), '# Resume');
  assert.equal(cleanDocument('```\nbody text\n```'), 'body text');
  assert.equal(cleanDocument('  plain  '), 'plain');
  assert.equal(cleanDocument(null), '');
});

test('parseReviewerResponse handles plain, fenced, and chatty JSON', () => {
  const obj = { resume: 'r', cover_letter: 'c', assessment: 'a' };
  assert.deepEqual(parseReviewerResponse(JSON.stringify(obj)), obj);
  assert.deepEqual(parseReviewerResponse('```json\n' + JSON.stringify(obj) + '\n```'), obj);
  assert.deepEqual(
    parseReviewerResponse('Here you go:\n' + JSON.stringify(obj) + '\nDone.'),
    obj
  );
  assert.equal(parseReviewerResponse('no json here'), null);
  assert.equal(parseReviewerResponse('{broken'), null);
  assert.equal(parseReviewerResponse(null), null);
});

test('qualityRank: grounded resumes outrank fabricated ones regardless of ATS', () => {
  const good = {
    facts: { ok: true, violations: [] },
    ats: { score: 70 },
    coverFacts: { ok: false },
  };
  const fabricatedHighAts = {
    facts: { ok: false, violations: [{ claim: '500 users' }] },
    ats: { score: 100 },
    coverFacts: { ok: true },
  };
  assert.ok(qualityRank(good) > qualityRank(fabricatedHighAts));
});

test('qualityRank: fewer violations and higher ATS rank higher; coverFacts breaks ties', () => {
  const base = { facts: { ok: false, violations: [{ claim: 'x' }] }, ats: { score: 60 }, coverFacts: { ok: true } };
  const fewer = { facts: { ok: false, violations: [] }, ats: { score: 60 }, coverFacts: { ok: true } };
  const higherAts = { facts: { ok: false, violations: [{ claim: 'x' }] }, ats: { score: 80 }, coverFacts: { ok: true } };
  const coverOk = { facts: { ok: false, violations: [{ claim: 'x' }] }, ats: { score: 60 }, coverFacts: { ok: true } };
  const coverBad = { facts: { ok: false, violations: [{ claim: 'x' }] }, ats: { score: 60 }, coverFacts: { ok: false } };
  assert.ok(qualityRank(fewer) > qualityRank(base));
  assert.ok(qualityRank(higherAts) > qualityRank(base));
  assert.ok(qualityRank(coverOk) > qualityRank(coverBad));
});

test('qualityRank tolerates missing reports', () => {
  assert.equal(qualityRank(null), qualityRank({}));
});

test('closestReusableJob picks the best same-employer match above the threshold', () => {
  const jd = 'Regional sales manager role for EV dealer network development across Ontario. Requires dealer network launches, revenue ownership, and EV retail go-to-market experience with Chinese OEM partners.';
  const strong = { id: 'a', company: 'BYD Canada', description: jd + ' ' + jd + ' Launch planning and revenue targets sit with the regional sales manager.' };
  const weak = { id: 'b', company: 'Bakery Co', description: 'Bakery counter position. Morning shifts. Pastry preparation and customer service at a busy downtown kiosk location with early hours.' };
  const best = closestReusableJob([weak, strong], { company: 'BYD Canada', description: jd });
  assert.ok(best, 'expected a reusable match');
  assert.equal(best.id, 'a');
  assert.ok(best.similarity >= REUSE_SIMILARITY_THRESHOLD);
});

test('closestReusableJob ignores other employers, below-threshold, short, and malformed rows', () => {
  const jd = 'Regional sales manager role for EV dealer network development across Ontario with revenue ownership.';
  assert.equal(closestReusableJob([{ id: 'a', company: 'Other Motors', description: jd + ' padding '.repeat(20) }], { company: 'BYD Canada', description: jd }), null);
  assert.equal(closestReusableJob([{ id: 'a', company: 'BYD Canada', description: 'unrelated bakery kiosk text about pastry shifts' }], { company: 'BYD Canada', description: jd }), null);
  assert.equal(closestReusableJob([{ id: 'a', description: 'too short' }], { description: jd }), null);
  assert.equal(closestReusableJob('not-an-array', { description: jd }), null);
  assert.equal(closestReusableJob([{ id: 'a', company: 'BYD Canada', description: jd + ' padding '.repeat(20) }], { company: 'BYD Canada', description: '' }), null);
  assert.equal(sameEmployer('BYD & Co.', 'BYD and Co'), true);
  assert.equal(sameEmployer('BYD Canada', 'Other Motors'), false);
});

test('reusableQuality: missing legacy block accepted, explicit failure rejected', () => {
  assert.equal(reusableQuality(null), true);
  assert.equal(reusableQuality({}), true);
  assert.equal(reusableQuality({ quality: { atsPass: true, facts: { ok: true } } }), true);
  assert.equal(reusableQuality({ quality: { atsPass: false, facts: { ok: true } } }), false);
  assert.equal(reusableQuality({ quality: { atsPass: true, facts: { ok: false } } }), false);
});

test('reusableQuality: incomplete quality block is rejected', () => {
  assert.equal(reusableQuality({ quality: { ats: { score: 72 } } }), false);
});

test('buildQualityReport flags fabricated claims and passes grounded ones', () => {
  const profile = 'Arshad Kazi scaled revenue from \$0 to \$20M across Ontario. Trained 120 dealership staff. Contact: arshad@example.com +1 416 555 1234';
  const jd = 'We need an EV regional sales manager to own dealer network development and revenue across Ontario. The role reports on fleet growth and launch execution.';
  const goodResume = [
    '# Arshad Kazi',
    '',
    'arshad@example.com +1 416 555 1234',
    '',
    '## PROFESSIONAL SUMMARY',
    'EV commercial leader for this regional sales manager role.',
    '',
    '## SKILLS',
    'dealer network development, revenue ownership, EV retail',
    '',
    '## PROFESSIONAL EXPERIENCE',
    '### Regional Sales Lead (01/2020 - 12/2024)',
    '- Scaled revenue from \$0 to \$20M across Ontario.',
    '- Trained 120 dealership staff on EV retail.',
    '',
    '## EDUCATION',
    'BComm',
  ].join('\n');
  const fabricatedResume = goodResume.replace('\$0 to \$20M', '\$0 to \$95M');
  const cover = 'Dear Hiring Manager, I scaled revenue from \$0 to \$20M and trained 120 dealership staff.';

  const good = buildQualityReport({
    resumeMd: goodResume, coverMd: cover, jdText: jd, profileText: profile, referenceText: null,
  });
  assert.equal(good.facts.ok, true, JSON.stringify(good.facts));

  const bad = buildQualityReport({
    resumeMd: fabricatedResume, coverMd: cover, jdText: jd, profileText: profile, referenceText: null,
  });
  assert.equal(bad.facts.ok, false);
  assert.ok(bad.facts.violations.length >= 1);
  assert.ok(qualityRank(good) > qualityRank(bad));
});import { parseReviewerSections } from '../functions/_lib/generation-quality.js';
test('parseReviewerSections extracts delimited documents', () => {
  const raw = '<<<RESUME\n# Ada\nBuilt things.\n>>>\n<<<COVER_LETTER\nDear team,\n>>>\n<<<ASSESSMENT\nTightened bullets.\n>>>';
  const parsed = parseReviewerSections(raw);
  assert.equal(parsed.resume, '# Ada\nBuilt things.');
  assert.equal(parsed.cover_letter, 'Dear team,');
  assert.equal(parsed.assessment, 'Tightened bullets.');
});
test('parseReviewerSections tolerates chatty wrappers and CRLF, rejects missing sections', () => {
  const raw = 'Here you go:\r\n<<<RESUME\r\nResume body\r\n>>>\r\n<<<COVER_LETTER\r\nCover body\r\n>>> thanks';
  const parsed = parseReviewerSections(raw);
  assert.equal(parsed.resume, 'Resume body');
  assert.equal(parsed.cover_letter, 'Cover body');
  assert.equal(parsed.assessment, '');
  assert.equal(parseReviewerSections('<<<RESUME\nonly one\n>>>'), null);
  assert.equal(parseReviewerSections('no delimiters at all'), null);
});
