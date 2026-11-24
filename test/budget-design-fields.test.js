'use strict';
// A design field the budget does not read is a typo, and a typo that names loss must not be skipped.
//
// The defect this suite pins: `opticalBudget` read `design.splitters` and ignored `design.splitter`,
// so a caller who wrote the singular got a budget with the splitter missing - on a 15 km GPON B+
// design, ODN 4.3 dB instead of 14.8 dB, a received power 10.5 dB optimistic, and a verdict computed
// on fibre that will not light. No error, no warning, HTTP 200.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

// 15.0 km g652d-loose-12 @ 1490 nm: 15.0 x 0.22 = 3.30; 4 splices x 0.10 = 0.40;
// 2 connectors x 0.30 = 0.60; plc-1x8-sca 9.03 dB + 1.47 dB excess = 10.50  ->  ODN 14.80 dB
function longPon(overrides) {
  return Object.assign({
    olt: { model: 'gpon-b-plus-8' },
    ont: { model: 'gpon-ont-1ge' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 15000 }],
    splices: 4,
    connectors: 2,
    splitters: [{ model: 'plc-1x8-sca' }]
  }, overrides || {});
}

test('the correct plural budgets the splitter', function () {
  const r = budget.opticalBudget(longPon(), registry);
  close(r.odnLossDb, 14.8, 0.001, 'ODN loss with the 1:8 splitter');
  close(r.rxPowerDbm, 1.5 - 14.8, 0.001, 'receive power at the +1.5 dBm launch floor');
});

test('a singular `splitter` is refused, naming the field that was meant', function () {
  const typo = longPon({ splitters: undefined, splitter: { model: 'plc-1x8-sca' } });
  throws(function () { budget.opticalBudget(typo, registry); }, 'splitters', 'the suggestion');
});

test('the refusal says a near miss is skipped loss, not a setting', function () {
  const typo = longPon({ splitters: undefined, splitter: { model: 'plc-1x8-sca' } });
  let message = '';
  try { budget.opticalBudget(typo, registry); } catch (err) { message = err.message; }
  assert.strictEqual(typeof message, 'string');
  assert.ok(message.indexOf('"splitter"') !== -1, message);
  assert.ok(message.indexOf('without saying so') !== -1, 'the reason: ' + message);
  assert.ok(message.indexOf('splices') !== -1, 'the fields it does read are listed: ' + message);
});

test('a case slip on a known field is refused with the real casing', function () {
  // `headend` for `headEnd`: without the guard the engine reads `design.headEnd`, finds nothing, and
  // answers "design.headEnd.model is required" - the right refusal for a missing end, the wrong one
  // for a lower-case key, and it leaves the plain object the caller sent untouched and unexplained.
  const typo = { headend: { model: 'sfp-plus-10g-lr-10km' }, cpe: { model: 'sfp-plus-10g-lr-10km' } };
  let message = '';
  try { budget.pointToPoint(typo, registry); } catch (err) { message = err.message; }
  assert.ok(message.indexOf('does not read the design field "headend"') !== -1, message);
  assert.ok(message.indexOf('did you mean "headEnd"') !== -1, message);
});

test('a prefix of a known field is refused with the full name', function () {
  // `margin` is how a caller writes a design reserve by hand; the field is `marginDb`.
  throws(function () { budget.opticalBudget(longPon({ margin: 3 }), registry); }, 'marginDb', 'the full field');
});

test('a design with an unrelated extra key still budgets, unchanged', function () {
  // A guard that refused every key it does not know would make the budget unusable for a caller
  // carrying its own metadata. Only a near miss of a field that exists is refused.
  const withMeta = budget.opticalBudget(longPon({ name: 'estate A', plantNotes: 'surveyed 2026-11' }), registry);
  const plain = budget.opticalBudget(longPon(), registry);
  close(withMeta.odnLossDb, plain.odnLossDb, 0.001, 'same loss with and without unrelated keys');
  assert.strictEqual(withMeta.verdict, plain.verdict);
});

test('the active budget refuses a typo the same way', function () {
  const typo = { headEnd: { model: 'sfp-plus-10g-lr-10km' }, cpe: { model: 'sfp-plus-10g-lr-10km' }, span: [] };
  throws(function () { budget.pointToPoint(typo, registry); }, 'spans', 'the plural');
});

done();
