import test from 'node:test';
import assert from 'node:assert/strict';
import { assessKnockout, MAX_TEXT } from '../functions/_lib/knockout.js';
test('missing and ambiguous text never rejects', () => { assert.deepEqual(assessKnockout(''), { eligible:true, warning:null, reason:null }); assert.equal(assessKnockout('may close soon; authorization preferred').eligible, true); });
test('explicit signals produce capped deterministic warnings only', () => { const r=assessKnockout('Position is closed'); assert.deepEqual(r,{eligible:true,warning:'role closed',reason:'role closed'}); assert.equal(assessKnockout('x'.repeat(MAX_TEXT+100)).eligible,true); });
