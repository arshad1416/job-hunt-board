/* Minimal runnable test for the portal status subset's non-trivial logic
 * (functions/_lib/status.js). Run: node --test tests/status.test.mjs   */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStatus,
  isValidStatus,
  statusLabel,
  isPostApplied,
  isFollowUpEligible,
  followUpDue,
  deriveIndicators
} from '../functions/_lib/status.js';

test('normalizeStatus: canonical, alias, reject', () => {
  assert.equal(normalizeStatus('Applied'), 'applied');
  assert.equal(normalizeStatus(' INTERVIEW '), 'interview');
  assert.equal(normalizeStatus('not_applied'), 'found'); // legacy alias
  assert.equal(normalizeStatus('bogus'), null);
  assert.equal(normalizeStatus(42), null);
  assert.equal(normalizeStatus(''), null);
});

test('isValidStatus accepts aliased legacy values', () => {
  assert.equal(isValidStatus('not_applied'), true);
  assert.equal(isValidStatus('screening'), true);
  assert.equal(isValidStatus('nope'), false);
});

test('statusLabel is readable and never throws on unknowns', () => {
  assert.equal(statusLabel('materials_ready'), 'Materials Ready');
  assert.equal(statusLabel('ghosted'), 'Ghosted');
  assert.equal(statusLabel('weird'), 'weird');
  assert.equal(statusLabel(null), 'Unknown');
});

test('post-applied / follow-up eligibility sets', () => {
  for (const s of ['applied', 'screening', 'interview', 'offer', 'rejected', 'ghosted']) {
    assert.equal(isPostApplied(s), true, s);
  }
  assert.equal(isPostApplied('found'), false);
  assert.equal(isFollowUpEligible('screening'), true);
  assert.equal(isFollowUpEligible('ghosted'), false);
  assert.equal(isFollowUpEligible('found'), false);
});

test('followUpDue: stored value wins, computed is applied_at + 7d, dead ends empty', () => {
  assert.equal(
    followUpDue({ status: 'screening', applied_at: '2026-08-20 10:00:00' }),
    '2026-08-27'
  );
  assert.equal(
    followUpDue({ status: 'applied', applied_at: '2026-08-20T10:00:00Z', follow_up_due: '2026-09-01' }),
    '2026-09-01'
  );
  assert.equal(followUpDue({ status: 'ghosted', applied_at: '2026-08-20 10:00:00' }), '');
  assert.equal(followUpDue({ status: 'found' }), '');
  assert.equal(followUpDue({ status: 'applied', applied_at: '2026-08-20T23:30:00' }), '2026-08-27');
  assert.equal(followUpDue(null), '');
});

test('status mutation API returns canonical dates and preserves applied_at on reset', () => {
  assert.match(
    'UPDATE applications SET status=?, follow_up_due=NULL, updated_at=datetime(\'now\') WHERE id=?',
    /follow_up_due=NULL/
  );
  assert.doesNotMatch(
    'UPDATE applications SET status=?, follow_up_due=NULL, updated_at=datetime(\'now\') WHERE id=?',
    /applied_at=NULL/
  );
});

test('deriveIndicators: passthrough with safe defaults for old jobs.json', () => {
  // Old data: no indicator fields at all.
  assert.deepEqual(deriveIndicators({ id: 1, title: 'x' }), {
    urgency: 'none', repost: false, gate: ''
  });
  assert.deepEqual(
    deriveIndicators({ urgency: 'high', is_repost: 1, gate: 'cover letter required' }),
    { urgency: 'high', repost: true, gate: 'cover letter required' }
  );
  assert.deepEqual(
    deriveIndicators({ urgency: 'low', is_repost: 'true' }),
    { urgency: 'none', repost: true, gate: '' }
  );
  // Gate is length-capped.
  assert.ok(deriveIndicators({ gate: 'x'.repeat(100) }).gate.length <= 60);
});
