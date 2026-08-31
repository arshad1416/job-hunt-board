import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tursoQuery, tursoExecute } from '../scripts/lib/turso.mjs';

const args = [3, 2.5, true, null, 'x'];
const expected = [
  { type: 'integer', value: '3' },
  { type: 'float', value: '2.5' },
  { type: 'integer', value: '1' },
  { type: 'null' },
  { type: 'text', value: 'x' }
];

function mockFetch(response) {
  let request;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    return { ok: true, async json() { return response; } };
  };
  return () => request;
}

test('Turso pipeline serializes typed argument values as strings', async () => {
  const getRequest = mockFetch({ results: [{ result: { cols: [], rows: [] } }] });
  await tursoQuery({ TURSO_URL: 'https://db.turso.io', TURSO_TOKEN: 'token' }, 'SELECT ?', args);
  assert.deepEqual(getRequest().requests[0].stmt.args, expected);

  const getExecuteRequest = mockFetch({ results: [{ result: { affected_row_count: 1 } }] });
  await tursoExecute({ TURSO_URL: 'https://db.turso.io', TURSO_TOKEN: 'token' }, 'UPDATE x SET y=?', args);
  assert.deepEqual(getExecuteRequest().requests[0].stmt.args, expected);
});
