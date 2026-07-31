/**
 * Single-instance lock for the outbound-fetching scripts.
 *
 * check-liveness.mjs and backfill-descriptions.mjs both walk job URLs on
 * LinkedIn and Indeed. Two of them running at once doubles the request
 * rate against exactly the hosts we are most careful with, and that can
 * happen easily — a dispatched session that appears stalled is often just
 * slow, and re-dispatching looks harmless from the outside.
 *
 * So the scripts refuse to start while another fetching run holds the
 * lock. A lock whose owning process is gone, or which is older than
 * STALE_AFTER_MS, is treated as abandoned and taken over.
 *
 * The lock is shared across BOTH scripts by design: they compete for the
 * same rate-limit budget, so they must not overlap with each other either.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LOCK_PATH = join(tmpdir(), 'job-hunt-board-fetch.lock');

/** A run older than this is assumed dead; a full pass is ~5h, so allow 6. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** True when the process that wrote the lock is still alive. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 tests existence without touching it
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return err.code === 'EPERM';
  }
}

/**
 * Take the lock, or explain why we can't.
 *
 * @param {string} owner  script name, for the message the next run sees
 * @param {{force?: boolean, startedAtMs: number}} opts
 *   startedAtMs must be supplied by the caller so this module needs no clock
 *   of its own beyond staleness maths.
 * @returns {{ok: true, release: () => void} | {ok: false, reason: string}}
 */
export function acquireFetchLock(owner, { force = false, startedAtMs } = {}) {
  const existing = readLock();

  if (existing && !force) {
    const age = startedAtMs - (existing.startedAtMs || 0);
    const alive = pidAlive(existing.pid);

    if (alive && age < STALE_AFTER_MS) {
      const mins = Math.round(age / 60000);
      return {
        ok: false,
        reason:
          `another fetching run is already in progress: ${existing.owner} ` +
          `(pid ${existing.pid}, started ${mins} min ago).\n` +
          'Running two at once doubles the request rate against LinkedIn and ' +
          'Indeed. Wait for it to finish, or pass --force if you are certain ' +
          'it is dead.'
      };
    }
    // Stale: the owner died, or it has been running implausibly long.
  }

  writeFileSync(
    LOCK_PATH,
    JSON.stringify({ owner, pid: process.pid, startedAtMs }, null, 2)
  );

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Only clear the lock if it is still ours.
      const now = readLock();
      if (now && now.pid === process.pid) unlinkSync(LOCK_PATH);
    } catch {
      // Nothing useful to do; a stale lock is recoverable on the next run.
    }
  };

  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      release();
      process.exit(130);
    });
  }

  return { ok: true, release, tookOverStale: !!existing };
}

export { LOCK_PATH, STALE_AFTER_MS };
