import test from 'node:test';
import assert from 'node:assert/strict';
import { assessKnockout, MAX_TEXT, normalizeInput } from '../functions/_lib/knockout.js';
test('missing and ambiguous text never rejects', () => { assert.deepEqual(assessKnockout(''), { eligible:true, warning:null, reason:null }); assert.equal(assessKnockout('may close soon; authorization preferred').eligible, true); });
test('explicit signals produce capped deterministic warnings only', () => { const r=assessKnockout('Position is closed'); assert.deepEqual(r,{eligible:true,warning:'role closed',reason:'role closed'}); assert.equal(assessKnockout('x'.repeat(MAX_TEXT+100)).eligible,true); assert.equal(normalizeInput('  role\u00a0 is\n closed  '), 'role is closed'); });
test('ordering is stable and adversarial text cannot trigger unsupported reasons', () => { assert.equal(assessKnockout('Application has been rejected; position is closed').warning, 'role closed'); assert.equal(assessKnockout('must be authorized to work; must be based in Toronto').warning, null); assert.equal(Object.hasOwn(assessKnockout('Position is closed'), 'signal'), false); });
