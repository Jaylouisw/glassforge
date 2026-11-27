'use strict';
// A swapped adjacent pair is a near miss: the most common typo a hand on a keyboard produces.
//
// The guard that refuses a misspelled design field measures nearness with Levenshtein, and plain
// Levenshtein counts `ab` -> `ba` as two edits. So a transposition was not a near miss at all: the key
// was ignored, the default ran, and the answer looked complete. Measured on `main` at 80e71b4 with the
// matcher Damerau-free:
//
//   budget.opticalBudget({ ..., marignDb: 10 }) on the 24 km design below  -> verdict ok, marginDb 3
//   length.cableToBuy({ routeM: 1000, overlenghtPct: 10 })                -> designM 1030, the 3% default
//   design.synthesise({ ..., overlenghtPct: 10 })                         -> the 3% default design length
//
// The 24 km row is the one that moves a verdict: 3 dB of reserve leaves 8.72 dB of headroom over the
// reserve and answers ok; the 10 dB the caller wrote leaves 1.72 dB and answers marginal. A silenced
// reserve turned a marginal link into an ok one.
//
// The fix is one step in `design-fields.distance` (optimal-string-alignment: a swap is one edit), so
// every entry point that already refuses a near miss refuses this one too. Each surface gets its own
// assertion here rather than riding along in the suite that guards its values, because each one is a
// place a caller's typo used to reach a plan.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');
const designFields = require('../engine/design-fields');

const registry = engine.createRegistry();
const budget = engine.budget;
const lengthModule = engine.length;
const design = engine.design;

// 24.0 km g652d-loose-12 @ 1490 nm: 24.0 x 0.22 = 5.28; 4 splices x 0.10 = 0.40;
// 2 connectors x 0.30 = 0.60; plc-1x8-sca 9.03 dB + 1.47 dB excess = 10.50  ->  ODN 16.78 dB.
// Launch floor +1.5 dBm -> rx -15.28 dBm; gpon-ont-1ge sensitivity -27 dBm -> headroom 11.72 dB.
function longPon(extra) {
  return Object.assign({
    olt: { model: 'gpon-b-plus-8' },
    ont: { model: 'gpon-ont-1ge' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 24000 }],
    splices: 4,
    connectors: 2,
    splitters: [{ model: 'plc-1x8-sca' }]
  }, extra || {});
}

test('the matcher reads a swapped pair as one edit, whichever way round it is typed', function () {
  const known = ['marginDb', 'overlengthPct', 'thirdParty', 'spliceReserveM'];
  assert.strictEqual(designFields.suggestField('marignDb', known), 'marginDb', 'marignDb');
  assert.strictEqual(designFields.suggestField('overlenghtPct', known), 'overlengthPct', 'overlenghtPct');
  assert.strictEqual(designFields.suggestField('thridParty', known), 'thirdParty', 'thridParty');
  // A single deletion and a case slip still resolve as they did before the transposition step.
  assert.strictEqual(designFields.suggestField('conectors', ['connectors']), 'connectors', 'one deletion');
  assert.strictEqual(designFields.suggestField('margindb', ['marginDb']), 'marginDb', 'a case slip');
});

test('the net stays narrow: a word that is not a near miss is still ignored', function () {
  // `ontology` starts with `ont` but is not a prefix of it, and no swap makes it one: a caller's own
  // bookkeeping key must still pass through, or the guard refuses somebody who is not wrong.
  assert.strictEqual(designFields.suggestField('ontology', ['olt', 'ont', 'spans']), null, 'ontology');
  assert.strictEqual(designFields.suggestField('notes', ['olt', 'ont', 'spans']), null, 'notes');
});

test('the PON budget refuses a transposed reserve, naming the field it reads', function () {
  const err = throws(function () { budget.opticalBudget(longPon({ marignDb: 10 }), registry); },
    'marginDb', 'a transposed marginDb');
  assert.ok(err instanceof TypeError, 'a client-caused refusal is a TypeError, so the endpoint answers 400');
  assert.ok(err.message.indexOf('"marignDb"') !== -1, 'quotes the key as sent: ' + err.message);
});

test('the 10 dB reserve the typo silenced was the one that decided the verdict', function () {
  // The design the caller asked for, spelled right: 10 dB of reserve over 11.72 dB of headroom is
  // marginal, and the sentence says which figure is tight. With the typo the same body answered ok at
  // the 3 dB default - the plan the caller's own reserve exists to flag.
  const wanted = budget.opticalBudget(longPon({ marginDb: 10 }), registry);
  close(wanted.odnLossDb, 16.78, 0.001, 'ODN loss with the 1:8 splitter');
  assert.strictEqual(wanted.verdict, 'marginal', 'a 10 dB reserve is 1.72 dB over 11.72 dB of headroom');
  assert.ok(String(wanted.marginalReason).indexOf('10 dB') !== -1, wanted.marginalReason);
  const defaulted = budget.opticalBudget(longPon(), registry);
  assert.strictEqual(defaulted.verdict, 'ok', 'the 3 dB default is what the typo used to answer');
});

test('the active budget refuses a transposed reserve too', function () {
  const ptp = {
    headEnd: { model: 'sfp-plus-10g-er-40km' },
    cpe: { model: 'sfp-plus-10g-er-40km' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 1200 }],
    marignDb: 10
  };
  throws(function () { budget.pointToPoint(ptp, registry); }, 'marginDb', 'a transposed marginDb');
});

test('the cable calculation refuses a transposed overlength, and the right spelling buys the slack', function () {
  throws(function () { lengthModule.cableToBuy({ routeM: 1000, overlenghtPct: 10 }); },
    'overlengthPct', 'a transposed overlengthPct');
  // The number the typo used to quote, and the one the caller asked for: 1000 x 1.10 = 1100 m against
  // the 3% default's 1030 m - 70 m of named slack missing from the purchase.
  const bought = lengthModule.cableToBuy({ routeM: 1000, overlengthPct: 10 });
  close(bought.designM, 1100, 0.001, 'design length at 10%');
});

test('the drawn-route form of the cable calculation refuses it too', function () {
  // The route form measures the polyline and then calls `cableToBuy`, so the guard fires before the
  // length is measured - a typo is refused whether or not the route is placeable.
  throws(function () {
    lengthModule.cableToBuyForRoute([{ lat: 51.5, lon: -0.1 }, { lat: 51.5, lon: -0.099 }],
      { overlenghtPct: 10 });
  }, 'overlengthPct', 'a transposed overlengthPct on a route');
});

test('the design refuses a transposed option before it builds a plant', function () {
  const points = [];
  for (let i = 0; i < 8; i++) points.push({ label: 'House ' + (i + 1), lat: 51.5 + i * 0.0004, lon: -0.1 });
  const opts = { headEnd: { lat: 51.499, lon: -0.1006, name: 'PoP' }, overlenghtPct: 10 };
  throws(function () { design.synthesise(points, opts, registry); }, 'overlengthPct',
    'a transposed overlengthPct option');
});

done();
