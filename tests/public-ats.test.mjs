import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJobUrl, isSafePublicHttpUrl } from '../functions/_lib/job-url.mjs';
import {
  fetchPublicAtsJob,
  parsePublicAtsJob,
  resolvePublicAtsRequest,
} from '../functions/_lib/public-ats.mjs';
import { normalizeJobs } from '../scripts/jobspy_json.mjs';

test('canonicalJobUrl prefers and unwraps a Recruitics employer URL', () => {
  const employer = 'https://jobs.example.com/role/123?rx_id=tracking&utm_source=indeed';
  const direct = `https://jsv3.recruitics.com/redirect?rx_url=${encodeURIComponent(employer)}`;
  assert.equal(
    canonicalJobUrl({ job_url_direct: direct, job_url: 'https://indeed.com/viewjob?jk=abc' }),
    'https://jobs.example.com/role/123',
  );
});

test('jobspy bridge keeps the source URL while promoting the employer URL', () => {
  const jobs = normalizeJobs([{
    id: 'in-123',
    job_url: 'https://ca.indeed.com/viewjob?jk=123',
    job_url_direct: 'https://jobs.example.com/role/123',
    description: '<p>Build useful systems.</p>',
  }]);
  assert.equal(jobs[0].source_job_url, 'https://ca.indeed.com/viewjob?jk=123');
  assert.equal(jobs[0].job_url, 'https://jobs.example.com/role/123');
  assert.equal(jobs[0].description, 'Build useful systems.');
});

test('public URL guard rejects local and credentialed targets', () => {
  assert.equal(isSafePublicHttpUrl('https://example.com/job'), true);
  assert.equal(isSafePublicHttpUrl('http://127.0.0.1/admin'), false);
  assert.equal(isSafePublicHttpUrl('http://[::1]/admin'), false);
  assert.equal(isSafePublicHttpUrl('http://[::ffff:7f00:1]/admin'), false);
  assert.equal(isSafePublicHttpUrl('https://user:pass@example.com/job'), false);
  assert.equal(isSafePublicHttpUrl('https://fcc.gov/jobs'), true);
});

test('resolves allowlisted ATS detail endpoints', () => {
  assert.deepEqual(
    resolvePublicAtsRequest('https://job-boards.greenhouse.io/acme/jobs/123456'),
    {
      provider: 'greenhouse',
      apiUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/123456?content=true',
      init: { headers: { accept: 'application/json' }, redirect: 'error' },
    },
  );
  assert.equal(
    resolvePublicAtsRequest('https://jobs.lever.co/acme/12345678-abcd-4abc-8abc-123456789012').apiUrl,
    'https://api.lever.co/v0/postings/acme/12345678-abcd-4abc-8abc-123456789012',
  );
  assert.equal(
    resolvePublicAtsRequest('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Toronto/Engineer_R123').apiUrl,
    'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/careers/job/Toronto/Engineer_R123',
  );
  assert.equal(
    resolvePublicAtsRequest('https://jobs.smartrecruiters.com/Acme/743999123456789-engineer').apiUrl,
    'https://api.smartrecruiters.com/v1/companies/Acme/postings/743999123456789',
  );
  assert.equal(resolvePublicAtsRequest('https://linkedin.com/jobs/view/123456789'), null);
});

test('parses Greenhouse, Lever, Workday, and SmartRecruiters descriptions', () => {
  assert.equal(
    parsePublicAtsJob('greenhouse', { content: '<p>Build useful systems.</p>', title: 'Engineer' }).description,
    'Build useful systems.',
  );
  assert.equal(
    parsePublicAtsJob('greenhouse', { content: btoa('<p>Encoded JD</p>'), title: 'Engineer' }).description,
    'Encoded JD',
  );
  const frenchBytes = new TextEncoder().encode('<p>Expérience au Québec</p>');
  let frenchBinary = '';
  for (const byte of frenchBytes) frenchBinary += String.fromCharCode(byte);
  assert.equal(
    parsePublicAtsJob('greenhouse', { content: btoa(frenchBinary), title: 'Engineer' }).description,
    'Expérience au Québec',
  );
  assert.equal(
    parsePublicAtsJob('lever', {
      descriptionPlain: 'Own the platform.',
      lists: [{ content: '<li>Ship safely</li>' }],
    }).description,
    'Own the platform.\n\n• Ship safely',
  );
  assert.equal(
    parsePublicAtsJob('workday', { jobPostingInfo: { jobDescription: '<p>Lead delivery.</p>' } }).description,
    'Lead delivery.',
  );
  assert.equal(
    parsePublicAtsJob('smartrecruiters', {
      jobAd: { sections: { jobDescription: { text: '<p>Design APIs.</p>' } } },
    }).description,
    'Design APIs.',
  );
});

test('fetchPublicAtsJob never follows an arbitrary API target', async () => {
  let called = false;
  const result = await fetchPublicAtsJob('http://127.0.0.1/job', {
    fetchImpl: async () => { called = true; },
  });
  assert.deepEqual(result, { supported: false });
  assert.equal(called, false);
});

test('fetchPublicAtsJob preserves definitive HTTP status', async () => {
  const result = await fetchPublicAtsJob('https://job-boards.greenhouse.io/acme/jobs/123456', {
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(result.supported, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});
