import test from 'node:test';
import assert from 'node:assert/strict';
import { signedMaterialUrls } from '../functions/_lib/signing.js';
test('signed material URLs include version-bound PDF links', async () => {
  const urls = await signedMaterialUrls({ DASHBOARD_AUTH_TOKEN: 'test-secret' }, '42', 60, 'a'.repeat(64));
  assert.ok(urls.resume_pdf.includes('/42/versions/' + 'a'.repeat(64) + '/resume.pdf?token=v1.'));
  assert.ok(urls.cover_letter_pdf.includes('/cover_letter.pdf?token=v1.'));
  assert.ok(urls.resume.includes('resume.md?token='));
});
