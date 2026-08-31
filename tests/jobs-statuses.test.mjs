import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/jobs/statuses.js';
const req = (url) => ({ request: new Request('https://x' + url), env: {} });
test('validates bounded IDs and malformed inputs', async () => { assert.equal((await onRequestGet(req('/api/jobs/statuses'))).status, 400); assert.equal((await onRequestGet(req('/api/jobs/statuses?ids=' + Array(101).fill('1').join(',')))).status, 400); assert.equal((await onRequestGet(req('/api/jobs/statuses?ids=x'))).status, 400); });
