/**
 * Minimal Turso HTTP v2 pipeline client for the Node-side maintenance scripts.
 *
 * Deliberately a standalone copy of functions/_lib/turso.js rather than an
 * import: that file is a Workers module and the repo has no package.json
 * (static-first, no build step), so Node would load a bare .js as CommonJS
 * and choke on its ESM exports. Adding a package.json just to bridge that
 * risks Cloudflare Pages deciding this project has a build.
 *
 * Reads TURSO_URL and TURSO_TOKEN from the environment.
 */

function buildArg(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer', value: String(value) }
      : { type: 'float', value };
  }
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  return { type: 'text', value: String(value) };
}

function extractValue(cell) {
  if (!cell || cell.type === 'null') return null;
  if (cell.type === 'integer') return parseInt(cell.value, 10);
  if (cell.type === 'float') return parseFloat(cell.value);
  return cell.value;
}

function requireConfig(env) {
  const url = (env.TURSO_URL || '').replace(/\/$/, '');
  const token = env.TURSO_TOKEN || '';
  if (!url || !token) {
    throw new Error(
      'TURSO_URL and TURSO_TOKEN must be set.\n' +
      '  export TURSO_URL="https://<db>.turso.io"\n' +
      '  export TURSO_TOKEN="$(turso db tokens create <db>)"'
    );
  }
  return { url, token };
}

async function pipeline(env, sql, args = []) {
  const { url, token } = requireConfig(env);

  const res = await fetch(url + '/v2/pipeline', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requests: [
        { type: 'execute', stmt: { sql, args: args.map(buildArg) } },
        { type: 'close' }
      ]
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Turso HTTP ' + res.status + ': ' + text.slice(0, 300));
  }

  const data = await res.json();
  const first = (data.results || [])[0];
  if (!first) throw new Error('Turso returned no results');
  if (first.type === 'error') {
    throw new Error('Turso error: ' + (first.error?.message || 'unknown'));
  }

  const result =
    first.response?.result || first.response?.execute?.result || first.result;
  if (!result || typeof result !== 'object') {
    throw new Error('Turso response has unrecognized shape');
  }
  return result;
}

/** Run a SELECT and return rows as plain objects keyed by column name. */
export async function tursoQuery(env, sql, args = []) {
  const result = await pipeline(env, sql, args);
  const cols = result.cols || [];
  const rows = result.rows || [];
  return rows.map(row => {
    const obj = {};
    cols.forEach((col, i) => {
      obj[col.name || col] = extractValue(row[i]);
    });
    return obj;
  });
}

/** Run an INSERT/UPDATE/DDL statement and return affected-row metadata. */
export async function tursoExecute(env, sql, args = []) {
  const result = await pipeline(env, sql, args);
  return {
    affectedRowCount: result.affected_row_count || 0,
    lastInsertRowid: result.last_insert_rowid ?? null
  };
}

/** True when `column` exists on `table`. Used to keep migrations idempotent. */
export async function hasColumn(env, table, column) {
  const rows = await tursoQuery(env, `PRAGMA table_info(${table})`);
  return rows.some(
    r => String(r.name || '').toLowerCase() === column.toLowerCase()
  );
}
