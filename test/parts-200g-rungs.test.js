'use strict';
// DR4 and LR4 complete the 200G rung at its ends: 500 m and 10 km, the two distances every other
// speed already carried (10GBASE-LR, 25GBASE-LR, 50GBASE-LR, 100GBASE-LR1/LR4; DR under FR1/FR4).
// Same conventions as parts-200g-qsfp56: the average receive power minimum is the sensitivity (a
// launch figure is subtracted from an average receive figure), the class ends are
// launch-minus-sensitivity and launch-ceiling-minus-overload, and every verdict below is measured by
// driving budget.pointToPoint rather than read off the sheets.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

const DR = 'qsfp56-200g-dr4-500m';
const LR = 'qsfp56-200g-lr4-10km';

function link(model, lengthM, connectorModel) {
  return budget.pointToPoint({
    headEnd: { model: model },
    cpe: { model: model },
    spans: lengthM === 0 ? [] : [{ cable: 'g652d-loose-12', lengthM: lengthM }],
    connectors: connectorModel ? { model: connectorModel, count: 2 } : 0
  }, registry);
}

test('DR4 is a 3 dB lane class, and its launch ceiling is above its receive maximum', function () {
  // Gigalight GQS-SPO201-DR4CZ, per lane: launch -5.1..+4.0, average receive -8.1..+3.0, OMAouter
  // sensitivity -6.6, stressed -4.1, damage +4.0. FiberStamp FST-200G-DR4 prints the same four.
  const dr = registry.get('transceiver', DR);
  assert.strictEqual(dr.speedMbps, 200000);
  assert.strictEqual(dr.reachM, 500, 'DR4 is the 500 m rung');
  assert.strictEqual(dr.polish, 'apc', 'the MPO-12 receptacle is 8 degree APC');
  assert.strictEqual(dr.txPowerDbmMin, -5.1);
  assert.strictEqual(dr.txPowerDbmMax, 4);
  assert.strictEqual(dr.rxSensitivityDbm, -8.1, 'average receive MIN, not the -6.6 OMA sensitivity');
  assert.strictEqual(dr.rxOverloadDbm, 3);
  // -5.1 - (-8.1) = 3.0 dB, the parallel-single-mode lane budget 100GBASE-DR and 400GBASE-DR4 spend
  close(dr.txPowerDbmMin - dr.rxSensitivityDbm, 3, 1e-9, 'the class is 3 dB');
  // +4.0 launch into a +3.0 receive maximum: 1 dB is the least loss that keeps the far end in range
  close(dr.txPowerDbmMax - dr.rxOverloadDbm, 1, 1e-9, 'the class floor is 1 dB of ODN');
});

test('a 500 m DR4 link needs 0.575 dB of ODN and fails the margin at the launch floor', function () {
  // 500 m x 0.35 = 0.175 dB of fibre + 2 x 0.2 dB of MPO/APC matings = 0.575 dB, 2.425 dB headroom
  const at500 = link(DR, 500, 'mpo-12-apc');
  close(at500.odnLossDb, 0.575, 0.001, '500 m x 0.35 + 2 x 0.2');
  close(at500.headroomDb, 2.43, 0.01, '3.0 - 0.575');
  assert.strictEqual(at500.verdict, 'fail', 'a 3 dB class under a 3 dB margin has no reserve');
  assert.strictEqual(at500.warnings.length, 1, 'the launch ceiling is above the receive maximum');
  // 100 m is no better: 0.435 dB of ODN and 2.57 dB of headroom, still short of the margin
  assert.strictEqual(link(DR, 100, 'mpo-12-apc').verdict, 'fail');
});

test('capping the DR4 launch at 3 dBm is what makes the row usable; the class stays 3 dB', function () {
  // The pair is budgeted at the launch it is given: 3.0 - (-8.1) = 11.1 dB, minus 0.575 dB of ODN.
  const capped = budget.pointToPoint({
    headEnd: { model: DR },
    cpe: { model: DR },
    txDbm: 3,
    spans: [{ cable: 'g652d-loose-12', lengthM: 500 }],
    connectors: { model: 'mpo-12-apc', count: 2 }
  }, registry);
  close(capped.headroomDb, 10.52, 0.01, '11.1 - 0.575');
  close(capped.classHeadroomDb, 2.42, 0.01, 'the class is still 3 dB, not the launch that was set');
  assert.strictEqual(capped.verdict, 'ok');
  assert.deepStrictEqual(capped.warnings, [], 'no pad is asked for at the DML ceiling');
  // 501 m is refused on reach while the loss budget is unchanged
  const past = link(DR, 501, 'mpo-12-apc');
  assert.ok(past.reasons.join(' ').indexOf('reaches 500') !== -1, past.reasons);
});

test('LR4 is a 6.3 dB class on one duplex pair, with a 0 dB floor', function () {
  // Gigalight GQS-SPO201-LR4CZ, per lane: launch -3.4..+5.3, average receive -9.7..+5.3, OMAouter
  // sensitivity -7.7, stressed -5.2. FS TRQ5F20ENF and Approved Networks AN-QSFP56-200G-LR4 agree.
  const lr = registry.get('transceiver', LR);
  assert.strictEqual(lr.speedMbps, 200000);
  assert.strictEqual(lr.reachM, 10000, 'LR4 is the 10 km rung');
  assert.strictEqual(lr.txPowerDbmMin, -3.4);
  assert.strictEqual(lr.txPowerDbmMax, 5.3);
  assert.strictEqual(lr.rxSensitivityDbm, -9.7, 'average receive MIN, not the -7.7 OMA sensitivity');
  assert.strictEqual(lr.rxOverloadDbm, 5.3, 'average receive MAX equals the launch ceiling');
  // -3.4 - (-9.7) = 6.3 dB, the 200GBASE-LR4 channel insertion loss
  close(lr.txPowerDbmMin - lr.rxSensitivityDbm, 6.3, 1e-9, 'the class is 6.3 dB');
  // +5.3 launch into a +5.3 receive maximum: a 0 dB floor, so this row never asks for a pad
  close(lr.txPowerDbmMax - lr.rxOverloadDbm, 0, 1e-9, 'the class floor is 0 dB');
});

test('the LR4 declared 10 km is inside the class and under the 3 dB margin', function () {
  // 10 km x 0.35 = 3.5 dB of fibre + 2 x 0.25 dB of LC/UPC matings = 4.0 dB, 2.3 dB of headroom
  const at10 = link(LR, 10000, 'lc-upc');
  close(at10.odnLossDb, 4, 0.001, '10 km x 0.35 + 2 x 0.25');
  close(at10.headroomDb, 2.3, 0.01, '6.3 - 4.0');
  assert.strictEqual(at10.verdict, 'fail', 'the margin refused it, not the class');
  assert.strictEqual(at10.attenuator, null, 'a 0 dB floor is not an overload row');
  // ok clears 5 dB of headroom: (6.3 - 0.5 - 5) / 0.35 = 2.285 km
  assert.strictEqual(link(LR, 2285, 'lc-upc').verdict, 'ok');
  // 8 km is 3.3 dB of ODN and exactly 3.0 dB of headroom: inside the margin, not the ok band
  assert.strictEqual(link(LR, 8000, 'lc-upc').verdict, 'marginal');
  assert.strictEqual(link(LR, 9000, 'lc-upc').verdict, 'fail');
});

done();
