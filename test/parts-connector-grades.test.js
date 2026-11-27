'use strict';
// The grade-B connector rows. IEC 61753-1:2007 Table A.12 (reprinted as ITU-T L.36 Table 9-1) grades
// random-mated single-mode connectors B: 0.12 dB mean / 0.25 dB max for >97% of samples, C: 0.25 /
// 0.50. The catalogue had one row per polish at grade C and called the LC pair "grade B typical" on a
// 0.25 dB figure that is grade B's MAXIMUM - so a design that contracted graded patch cords had no row
// to name, and the LC row that did exist was credited with a mean it is not sold to. This suite holds
// the two new rows to the published grade and drives the engine for the fractions they buy, because a
// note that says "0.6 dB across four matings" is a claim until a budget prints it.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const parts = engine.parts;
const network = engine.network;

// OLT - 500 m feeder - connectorised 1:8 - 40 m drop - ONT. designForOnt charges two end matings plus
// two for a connectorised splitter, so this path carries four matings on every run below.
const FOUR_MATINGS = {
  name: 'Four matings',
  nodes: [
    { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
    { id: 'n3', type: 'splitter', model: 'plc-1x8-sca-conn', name: 'Splitter 1:8' },
    { id: 'n5', type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 1' }
  ],
  spans: [
    { id: 's1', from: 'n1', to: 'n3', cable: 'g652d-loose-12', lengthM: 500 },
    { id: 's2', from: 'n3', to: 'n5', cable: 'g657a2-drop-1', lengthM: 40 }
  ]
};

function budgetWith(connectorModel) {
  const opts = connectorModel ? { connectorModel: connectorModel } : {};
  return network.designForOnt(FOUR_MATINGS, 'n5', registry, opts);
}

function connectorLine(result) {
  const lines = result.breakdown.filter(function (b) { return b.kind === 'connector'; });
  assert.strictEqual(lines.length, 1, 'one aggregated connector line, got ' + lines.length);
  return lines[0];
}

test('the grade-B rows validate and stop at grade B\'s ceiling, not at a vendor tolerance', function () {
  for (const model of ['sc-apc-lowloss', 'lc-apc-lowloss']) {
    const row = registry.get('connector', model);
    const check = parts.validateSpec(row);
    assert.ok(check.ok, model + ' validates: ' + check.errors.join('; '));
    assert.strictEqual(row.polish, 'apc', model + ' is an APC ferrule: a UPC one will not mate with it');
    // 0.25 dB is the published grade-B maximum for >97% of random mated samples; 0.15 is the typical
    // charged, sitting between grade B's 0.12 dB mean and that 0.25 ceiling.
    assert.strictEqual(row.maxLossDb, 0.25, model + ' ceiling is IEC 61753-1 grade B');
    assert.strictEqual(row.lossDb, 0.15, model + ' charges 0.15 dB typical per mating');
  }
});

test('a grade-B SC pair takes 0.15 dB off every mating the budget charges', function () {
  const standard = budgetWith('sc-apc');
  const graded = budgetWith('sc-apc-lowloss');
  // 4 matings x (0.30 - 0.15) = 0.6 dB. The four-mating line itself: 4 x 0.30 = 1.2 -> 4 x 0.15 = 0.6.
  close(connectorLine(standard).db, 4 * 0.3, 0.001, 'four sc-apc matings');
  close(connectorLine(graded).db, 4 * 0.15, 0.001, 'four sc-apc-lowloss matings');
  close(standard.odnLossDb - graded.odnLossDb, 0.6, 0.001, 'ODN delta over four matings');
  // 540 m at 0.22 = 0.1188, 1:8 chip 10.5, four matings 1.2 -> 11.8188 dB; the grade-B run is 11.2188.
  close(standard.odnLossDb, 11.8188, 0.001, 'fibre 0.1188 + chip 10.5 + matings 1.2');
  close(graded.odnLossDb, 11.2188, 0.001, 'fibre 0.1188 + chip 10.5 + matings 0.6');
});

test('a grade-B LC pair takes 0.10 dB off every mating, four tenths over the path', function () {
  const standard = budgetWith('lc-apc');
  const graded = budgetWith('lc-apc-lowloss');
  // lc-apc is 0.25 (grade C mean) so the saving per mating is 0.10, not the SC row's 0.15:
  // 4 x (0.25 - 0.15) = 0.4 dB.
  close(connectorLine(standard).db, 4 * 0.25, 0.001, 'four lc-apc matings');
  close(standard.odnLossDb - graded.odnLossDb, 0.4, 0.001, 'ODN delta over four matings');
});

test('the graded rows are a verdict on a real line, not a rounding', function () {
  // The examples sc-apc-lowloss's notes quote, driven: a class B+ line (28 dB) with a connectorised
  // 1:32 and 24.0 km of feeder. 1:32 chip 17.1, fibre 24040 m x 0.22 = 5.2888, matings 1.2 -> 23.5888.
  function longLine(lengthM) {
    return {
      name: 'B+ 1:32 long line',
      nodes: [
        { id: 'n1', type: 'olt', model: 'gpon-b-plus-8', name: 'OLT' },
        { id: 'n3', type: 'splitter', model: 'plc-1x32-sca-conn', name: 'Splitter 1:32' },
        { id: 'n5', type: 'ont', model: 'gpon-ont-b-plus-4ge', name: 'Casa 1' }
      ],
      spans: [
        { id: 's1', from: 'n1', to: 'n3', cable: 'g652d-loose-12', lengthM: lengthM },
        { id: 's2', from: 'n3', to: 'n5', cable: 'g657a2-drop-1', lengthM: 40 }
      ]
    };
  }
  const at = function (lengthM, model) {
    const opts = { connectorModel: model };
    return network.designForOnt(longLine(lengthM), 'n5', registry, opts);
  };

  const marginal = at(24000, 'sc-apc');
  const ok = at(24000, 'sc-apc-lowloss');
  close(marginal.odnLossDb, 23.5888, 0.001, 'chip 17.1 + fibre 5.2888 + matings 1.2');
  assert.strictEqual(marginal.verdict, 'marginal', 'sc-apc at 24.0 km is marginal, headroom 4.91 dB');
  close(marginal.headroomDb, 4.91, 0.01, 'launch floor and sensitivity give 4.91 dB');
  assert.strictEqual(ok.verdict, 'ok', 'the grade-B row buys the 0.6 dB that makes it ok');
  close(ok.headroomDb, 5.51, 0.01, '4.91 + 0.6 = 5.51 dB');

  const failing = at(33000, 'sc-apc');
  const rescued = at(33000, 'sc-apc-lowloss');
  assert.strictEqual(failing.verdict, 'fail', 'sc-apc at 33.0 km fails the 28 dB class');
  assert.strictEqual(rescued.verdict, 'marginal', 'grade B moves the same plant to marginal');
  close(failing.headroomDb, 2.93, 0.01, '2.93 dB is under the 3 dB margin');
  close(rescued.headroomDb, 3.53, 0.01, '2.93 + 0.6 = 3.53 dB');
});

test('nothing already budgeted moved: sc-apc is still the default connector', function () {
  // The rows are hand-select only. A plant with no connectorModel must budget the 0.30 dB default,
  // or every stored project silently gets 0.6 dB of headroom it never asked for.
  const implicit = budgetWith(undefined);
  const explicit = budgetWith('sc-apc');
  close(implicit.odnLossDb, explicit.odnLossDb, 0.000001, 'absent connectorModel = sc-apc');
  close(connectorLine(implicit).db, 4 * 0.3, 0.001, 'still 0.30 dB per mating');
});

test('every connector charges no more than the ceiling it declares', function () {
  const rows = registry.all('connector');
  assert.ok(rows.length >= 8, 'the catalogue has the standard and graded rows: ' + rows.length);
  for (const row of rows) {
    assert.ok(row.lossDb <= row.maxLossDb,
      row.model + ' charges ' + row.lossDb + ' dB against its own ' + row.maxLossDb + ' dB ceiling');
  }
  // A 0.25 dB ceiling is IEC 61753-1 grade B, and no row may declare it while charging above the
  // grade's own maximum.
  for (const row of rows.filter(function (r) { return r.maxLossDb === 0.25; })) {
    assert.ok(row.lossDb <= 0.25, row.model + ' declares a grade-B ceiling and charges above it');
  }
});

test('lc-apc says it is grade C now, not "grade B typical"', function () {
  // What it used to claim: "this row's 0.25 dB typical and 0.5 dB ceiling are grade B typical /
  // grade C max" - but grade B's mean is 0.12 dB, so a 0.25 dB figure is grade C's mean and grade B's
  // maximum. The number stayed (a random-mated commodity pair does sit there); the attribution moved,
  // and lc-apc-lowloss is the row a grade-B contract names.
  const row = registry.get('connector', 'lc-apc');
  assert.ok(row.notes.indexOf('grade B typical') === -1,
    'lc-apc still calls its 0.25 dB figure grade B typical');
  assert.ok(row.notes.indexOf('lc-apc-lowloss') !== -1,
    'lc-apc points at the row that does meet grade B');
  assert.strictEqual(row.lossDb, 0.25, 'the conservative figure was kept, not traded for a green test');
});

done();
