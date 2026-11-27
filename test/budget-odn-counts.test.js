'use strict';
// A count of splices or connectors is plant with a loss, and every refusal here exists because the
// engine used to read an unusable count as *no* plant: the key was right, the value was dropped, and
// the ODN loss - the figure the verdict is computed on - came out lower than the design asked for.
// The baseline design is the one those values rescue, so a change has to disagree with arithmetic.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

// GPON B+, 22.7 km of G.652.D at 1:64, 10 splices, 6 connectors.
//   fibre 22.7 x 0.22 = 4.994; splices 10 x 0.10 = 1.00; connectors 6 x 0.30 = 1.80;
//   plc-1x64-sca = 20.50  ->  ODN 28.294 dB, 0.294 dB over the GPON B+ 28 dB budget.
function design(overrides) {
  return Object.assign({
    olt: { model: 'gpon-b-plus-8' },
    ont: { model: 'gpon-ont-4ge' },
    wavelength: '1490',
    spans: [{ cable: 'g652d-loose-24', lengthM: 22700 }],
    splitters: [{ model: 'plc-1x64-sca' }],
    splices: 10,
    connectors: 6
  }, overrides || {});
}

function run(overrides) {
  return budget.opticalBudget(design(overrides), registry);
}

test('the design these counts are refused on fails, which is what makes them a defect', function () {
  const r = run();
  close(r.odnLossDb, 28.294, 0.001, 'ODN loss (4.994 + 1.00 + 1.80 + 20.50)');
  close(r.classHeadroomDb, -0.29, 0.001, 'class headroom against the 28 dB budget (28 - 28.294, rounded to 2)');
  assert.strictEqual(r.verdict, 'fail');
  // and the same design with the connectors the caller asked for removed is `ok` - the 1.80 dB is the
  // difference between a plan that fits the class budget and one that does not.
  const rescued = run({ connectors: 0 });
  close(rescued.odnLossDb, 26.494, 0.001, 'ODN loss without connectors');
  assert.strictEqual(rescued.verdict, 'ok');
});

test('a negative connector count is refused by name, not read as no connectors', function () {
  // -6 was the count a caller gets from two closures per joint minus two, and it silently became
  // 0 connectors: ODN 26.494 dB and `ok` on a design that fails with the six it meant.
  const err = throws(function () { run({ connectors: -6 }); }, 'design.connectors', 'negative connectors');
  assert.ok(String(err.message).indexOf('-6') !== -1, 'the refusal quotes the value it was given');
  assert.ok(String(err.message).indexOf('whole number') !== -1, 'the refusal says what it wanted');
});

test('a connector count that arrived as text is refused, not dropped', function () {
  // An API body with "6" in quotes used to answer `ok` with zero connectors.
  const err = throws(function () { run({ connectors: '6' }); }, 'design.connectors', 'text connectors');
  assert.ok(String(err.message).indexOf('"6"') !== -1, 'the refusal quotes the string it was given');
});

test('the connector object form is read strictly too', function () {
  // { model, count } is a documented form; the count inside it is the same count.
  throws(function () { run({ connectors: { model: 'sc-upc', count: -6 } }); }, 'design.connectors.count', 'negative count');
  throws(function () { run({ connectors: { model: 'sc-upc', count: 2.5 } }); }, 'design.connectors.count', 'fractional count');
  // A model with no count names a part and no plant: 0 connectors was the silent reading.
  throws(function () { run({ connectors: { model: 'sc-upc' } }); }, 'design.connectors', 'model without count');
  // A valid object form still counts, with its own model: 4.994 + 1.00 + 20.50 + 2 x 0.30 = 27.094 dB
  const r = run({ connectors: { model: 'sc-upc', count: 2 } });
  close(r.odnLossDb, 27.094, 0.001, 'ODN loss with two named connectors');
});

test('null and an empty array are present-and-unusable, not absent', function () {
  throws(function () { run({ connectors: null }); }, 'design.connectors', 'null connectors');
  throws(function () { run({ connectors: [] }); }, 'design.connectors', 'array connectors');
  // NaN is "not a number" arriving as a number, and the sentence says NaN rather than null (which is
  // what JSON.stringify would have printed for it).
  throws(function () { run({ connectors: NaN }); }, 'got NaN', 'NaN connectors');
});

test('zero connectors is a design choice and stays valid', function () {
  const r = run({ connectors: 0 });
  close(r.odnLossDb, 26.494, 0.001, '4.994 + 1.00 + 20.50');
  assert.strictEqual(r.breakdown.filter(function (b) { return b.kind === 'connector'; }).length, 0);
  // and an absent count is the same zero, which the breakdown says by carrying no connector row
  const absent = run({ connectors: undefined });
  close(absent.odnLossDb, 26.494, 0.001, 'absent connectors');
});

test('a negative or textual splice count is refused the same way', function () {
  throws(function () { run({ splices: -10 }); }, 'design.splices', 'negative splices');
  throws(function () { run({ splices: '10' }); }, 'design.splices', 'text splices');
  throws(function () { run({ splices: 2.5 }); }, 'design.splices', 'fractional splices');
  // zero and an empty list are both "no splices", and both still work: 4.994 + 1.80 + 20.50 = 27.294.
  close(run({ splices: 0 }).odnLossDb, 27.294, 0.001, 'zero splices');
  close(run({ splices: [] }).odnLossDb, 27.294, 0.001, 'empty splice list');
});

test('a splice entry that states its loss may not state a negative or textual one', function () {
  // Four entries at -0.5 dB used to *remove* 2 dB of plant: ODN 25.294 dB and an `ok` verdict.
  const negative = throws(function () { run({ splices: [{ lossDb: -0.5 }] }); }, 'design.splices[0].lossDb', 'negative splice loss');
  assert.ok(String(negative.message).indexOf('-0.5') !== -1, 'the refusal quotes the value');
  // A text loss was not read at all, so the entry silently took the model default - the caller's
  // number and the plan's number were different, with nothing in the answer saying so.
  throws(function () { run({ splices: [{ lossDb: '0.1' }] }); }, 'design.splices[0].lossDb', 'text splice loss');
  // The index in the refusal is the entry that is wrong, not the field.
  throws(function () { run({ splices: [{}, {}, { lossDb: -1 }] }); }, 'design.splices[2].lossDb', 'third entry');
});

test('a splice entry may state its loss, and a bare entry takes the model default', function () {
  // 4 x 0.5 = 2.00 dB: 4.994 + 1.80 + 20.50 + 2.00 = 29.294 dB
  close(run({ splices: [{ lossDb: 0.5 }, { lossDb: 0.5 }, { lossDb: 0.5 }, { lossDb: 0.5 }] }).odnLossDb,
    29.294, 0.001, 'stated splice losses');
  // 4 x fusion 0.10 dB = 0.40: 4.994 + 1.80 + 20.50 + 0.40 = 27.694 dB
  close(run({ splices: [{}, {}, {}, {}] }).odnLossDb, 27.694, 0.001, 'model default splice losses');
  // A splice entry that is not an object has no model and no loss to read.
  throws(function () { run({ splices: [0.1] }); }, 'design.splices[0]', 'bare number entry');
});

test('the active path reads the same counts through the same guard', function () {
  // computeOdn is shared, so a site-to-site budget refuses a text count exactly as the PON one does.
  const active = function (connectors) {
    return budget.pointToPoint({
      headEnd: { model: 'sfp-1g-ex-40km' }, cpe: { model: 'sfp-1g-ex-40km' },
      spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }], splices: 0, connectors: connectors
    }, registry);
  };
  throws(function () { active('2'); }, 'design.connectors', 'active text connectors');
  assert.ok(active(2).ok, 'the same link with two connectors is a valid budget');
});

test('a spans or splitters list the budget cannot read is refused, not read as no plant', function () {
  // `design.spans || []` and `design.splitters || []` answered a present-but-unusable list as an
  // empty one: `null`, `0`, `false` and `''` all became "no cable / no splitter". Measured on the
  // baseline design above with `spans: null`: 0 m of fibre, ODN 23.3 dB (splices + connectors + the
  // 20.50 dB 1:64, no fibre) and `verdict: ok`, while the plant it names is `fail` - 0.294 dB outside
  // the GPON B+ class budget. `{}` and `"x"` were already refused, so only the falsy values slipped by.
  throws(function () { run({ spans: null }); }, 'design.spans', 'a null spans list');
  throws(function () { run({ spans: 0 }); }, 'design.spans', 'a numeric spans list');
  throws(function () { run({ splitters: null }); }, 'design.splitters', 'a null splitters list');
  // Absent is still absent: the empty plant is the state the key omits, and it budgets as 0 m.
  const bare = budget.pointToPoint({ headEnd: { model: 'sfp-1g-lx-10km' }, cpe: { model: 'sfp-1g-lx-10km' } }, registry);
  close(bare.fibreLengthM, 0, 0.001, 'an omitted spans key is still no cable');
});

test('the active path refuses an unreadable spans list too, through the shared ODN', function () {
  // computeOdn is shared, so pointToPoint read `spans: null` as no cable in exactly the same way.
  throws(function () {
    budget.pointToPoint({ headEnd: { model: 'sfp-1g-lx-10km' }, cpe: { model: 'sfp-1g-lx-10km' },
      spans: null }, registry);
  }, 'design.spans', 'active null spans');
});

done();
