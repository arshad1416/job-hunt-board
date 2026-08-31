import test from 'node:test';
import assert from 'node:assert/strict';
import { assessKnockout } from '../functions/_lib/knockout.js';
test('only explicit signals knock out', () => { assert.equal(assessKnockout('This role may close soon.').eligible, true); assert.equal(assessKnockout('Position is closed.').reason, 'role closed'); assert.deepEqual(assessKnockout(''), { eligible: true, reason: null, signal: null }); });
