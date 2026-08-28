/* Focused test for /api/followup-draft pure logic
 * (functions/_lib/followup-draft.js).
 * Run: node --test tests/followup-draft.test.mjs   */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateFollowupBody,
  redactContacts,
  notesContext,
  buildFollowupPrompt,
  wordCount,
  DEFAULT_TONE,
  TONES
} from '../functions/_lib/followup-draft.js';

test('validateFollowupBody: numeric job_id + tone allowlist', () => {
  assert.deepEqual(validateFollowupBody({ job_id: 123 }), {
    ok: true, job_id: 123, tone: DEFAULT_TONE
  });
  assert.equal(validateFollowupBody({ job_id: '456', tone: 'warm' }).tone, 'warm');
  // rejects
  assert.ok(!validateFollowupBody({}).ok);
  assert.ok(!validateFollowupBody({ job_id: 'abc' }).ok);
  assert.ok(!validateFollowupBody({ job_id: '12.5' }).ok);
  assert.ok(!validateFollowupBody({ job_id: 0 }).ok);
  assert.ok(!validateFollowupBody({ job_id: -1 }).ok);
  assert.ok(!validateFollowupBody({ job_id: 1, tone: 'snarky' }).ok);
  assert.ok(!validateFollowupBody(null).ok);
  // every documented tone is accepted
  for (const t of TONES) {
    assert.equal(validateFollowupBody({ job_id: 9, tone: t }).ok, true, t);
  }
});

test('redactContacts strips emails, phones and links from notes', () => {
  const out = redactContacts(
    'Recruiter: jane.doe@acme.com +1 (416) 555-0199 see https://acme.com/portal'
  );
  assert.ok(!out.includes('jane.doe@acme.com'), 'email must be redacted');
  assert.ok(!out.includes('555-0199'), 'phone must be redacted');
  assert.ok(!out.includes('https://'), 'link must be redacted');
  assert.ok(out.includes('Recruiter:'), 'surrounding context is kept');
});

test('notesContext: bounded, redacted, empty-safe', () => {
  assert.equal(notesContext(''), '');
  assert.equal(notesContext(null), '');
  assert.ok(notesContext('a'.repeat(900)).length <= 502); // cap + ellipsis
});

test('buildFollowupPrompt: bounded fields, no invented-data invitation', () => {
  const p = buildFollowupPrompt({
    company: 'Acme', title: 'AI Engineer',
    status: 'screening', follow_up_due: '2026-09-01',
    notes: 'hr@acme.com said hi'
  }, 'brief');
  assert.ok(p.includes('Acme') && p.includes('AI Engineer'));
  assert.ok(p.includes('2026-09-01'));
  assert.ok(!p.includes('hr@acme.com'), 'raw email must not reach the prompt');
  assert.ok(p.includes('never invent'));
  // Every tone lands in the prompt.
  for (const t of TONES) {
    assert.ok(buildFollowupPrompt({ company: 'x', title: 'y' }, t).includes('TONE: ' + t));
  }
});

test('wordCount matches simple counting', () => {
  assert.equal(wordCount('hello world  foo'), 3);
  assert.equal(wordCount('  '), 0);
  assert.equal(wordCount(null), 0);
});
