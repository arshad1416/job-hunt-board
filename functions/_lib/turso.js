/* ═══════════════════════════════════════════════════════════════
   Turso HTTP v2 Pipeline API Helper
   Shared by all /api/* Pages Functions.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Build a typed arg object for the Turso pipeline API.
 * @param {*} value - JS value (string, number, boolean, null)
 * @returns {{type: string, value?: *}} typed arg
 */
function buildArg(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer', value: value }
      : { type: 'float', value: value };
  }
  if (typeof value === 'boolean') return { type: 'integer', value: value ? 1 : 0 };
  return { type: 'text', value: String(value) };
}

/**
 * Extract a plain JS value from a Turso typed cell.
 * @param {{type: string, value?: *}} cell
 * @returns {*} plain value
 */
function extractValue(cell) {
  if (!cell || cell.type === 'null') return null;
  if (cell.type === 'integer') return parseInt(cell.value, 10);
  if (cell.type === 'float') return parseFloat(cell.value);
  if (cell.type === 'blob') return cell.value; // base64 string
  return cell.value; // text
}

/**
 * Execute a SQL query via the Turso v2 pipeline API and return rows
 * as an array of plain objects keyed by column name.
 *
 * @param {object} env - Cloudflare env (TURSO_URL, TURSO_TOKEN)
 * @param {string} sql - SQL with ? placeholders
 * @param {Array} args - positional args (optional)
 * @returns {Promise<Array<object>>} rows as objects
 */
async function tursoQuery(env, sql, args = []) {
  const url = (env.TURSO_URL || '').replace(/\/$/, '') + '/v2/pipeline';

  const body = {
    requests: [
      {
        type: 'execute',
        stmt: {
          sql: sql,
          args: args.map(buildArg)
        }
      },
      { type: 'close' }
    ]
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + (env.TURSO_TOKEN || ''),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Turso HTTP ' + res.status + ': ' + text.slice(0, 200));
  }

  const data = await res.json();
  const results = data.results || [];
  const first = results[0];

  if (!first) throw new Error('Turso returned no results');
  if (first.type === 'error') {
    throw new Error('Turso error: ' + (first.error?.message || 'unknown'));
  }

  // Navigate the response structure (handles both known formats)
  const result =
    first.response?.result ||
    first.response?.execute?.result ||
    first.result ||
    first;

  const cols = result.cols || [];
  const rows = result.rows || [];

  // Map rows to objects keyed by column name
  return rows.map(row => {
    const obj = {};
    cols.forEach((col, i) => {
      obj[col.name || col] = extractValue(row[i]);
    });
    return obj;
  });
}

/**
 * Execute a SQL statement (INSERT/UPDATE/DELETE) via the Turso v2
 * pipeline API and return metadata (affected_row_count, last_insert_rowid).
 *
 * @param {object} env - Cloudflare env
 * @param {string} sql - SQL with ? placeholders
 * @param {Array} args - positional args
 * @returns {Promise<{affectedRowCount: number, lastInsertRowid: *}>}
 */
async function tursoExecute(env, sql, args = []) {
  const url = (env.TURSO_URL || '').replace(/\/$/, '') + '/v2/pipeline';

  const body = {
    requests: [
      {
        type: 'execute',
        stmt: {
          sql: sql,
          args: args.map(buildArg)
        }
      },
      { type: 'close' }
    ]
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + (env.TURSO_TOKEN || ''),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Turso HTTP ' + res.status + ': ' + text.slice(0, 200));
  }

  const data = await res.json();
  const results = data.results || [];
  const first = results[0];

  if (!first) throw new Error('Turso returned no results');
  if (first.type === 'error') {
    throw new Error('Turso error: ' + (first.error?.message || 'unknown'));
  }

  const result =
    first.response?.result ||
    first.response?.execute?.result ||
    first.result ||
    first;

  return {
    affectedRowCount: result.affected_row_count || 0,
    lastInsertRowid: result.last_insert_rowid ?? null
  };
}

export { tursoQuery, tursoExecute, buildArg, extractValue };
