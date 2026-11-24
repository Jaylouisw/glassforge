'use strict';
// 25GBASE-LR is the one optic in the catalogue whose figures were printed from an early draft rather
// than the published class: launch -4.5, sensitivity -11.4, overload 2.4, i.e. 6.9 dB between launch
// floor and sensitivity where IEEE 802.3cc allows 6.3. Every 25G link was budgeted 0.6 dB optimistic.
// This suite pins the row to the standard's tables and drives the two verdicts the error moved: the
// 10 km reach the label sells, and the overload verdict that a hotter launch ceiling could have added.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

const LR = { model: 'sfp28-25g-lr-10km' };

test('the 25GBASE-LR row carries the figures 802.3cc prints, not the draft it used to', function () {
  const lr = registry.get('transceiver', 'sfp28-25g-lr-10km');
  assert.strictEqual(lr.speedMbps, 25000);
  assert.strictEqual(lr.wavelengthNm, 1310);
  assert.strictEqual(lr.reachM, 10000);
  // IEEE 802.3cc Tables 114-6/114-7: average launch -7.0..+2.0, average receive -13.3 (min) .. +2.0 (max).
  assert.strictEqual(lr.txPowerDbmMin, -7);
  assert.strictEqual(lr.txPowerDbmMax, 2);
  assert.strictEqual(lr.rxSensitivityDbm, -13.3);
  assert.strictEqual(lr.rxOverloadDbm, 2);
  assert.ok(/^https:\/\//.test(lr.sourceUrl), lr.sourceUrl);

  // The pair's own budget is the class channel insertion loss: -7.0 - (-13.3) = 6.3 dB.
  // It was 6.9 dB (-4.5 - -11.4) before 2026-11-24, and that 0.6 dB is what the test below spends.
  const back = budget.pointToPoint({ headEnd: LR, cpe: LR, spans: [], splices: 0, connectors: 0 }, registry);
  close(back.budgetDb, 6.3, 0.001, 'link budget');
});

test('a bare 10 km span fails on the 3 dB margin by 0.2 dB, and 9.4 km is the last length that clears it', function () {
  const ten = budget.pointToPoint({ headEnd: LR, cpe: LR,
    spans: [{ cable: 'g652d-loose-12', lengthM: 10000 }], splices: 0, connectors: 0 }, registry);
  // 10.0 km x 0.35 dB/km = 3.5 dB -> rx -7.0 - 3.5 = -10.50 dBm
  close(ten.odnLossDb, 3.5, 0.001, 'ODN loss at 10 km');
  close(ten.rxPowerDbm, -10.5, 0.001, 'receive power');
  // headroom -10.5 - (-13.3) = 2.8 dB: audible, below the default 3 dB margin
  close(ten.headroomDb, 2.8, 0.001, 'headroom at 10 km');
  assert.strictEqual(ten.verdict, 'fail');
  assert.ok(ten.reasons.join(' ').indexOf('below the 3 dB design margin') !== -1, ten.reasons.join(' '));
  // It fails on margin, not on reach: 10 km is exactly the optic's declared reach.
  assert.strictEqual(ten.pathLengthM, 10000);
  assert.strictEqual(ten.reachM, 10000);
  assert.ok(ten.reasons.join(' ').indexOf('reaches') === -1, ten.reasons.join(' '));

  // 9.4 km x 0.35 = 3.29 dB -> headroom 6.3 - 3.29 = 3.01 dB, just over the margin
  const nineFour = budget.pointToPoint({ headEnd: LR, cpe: LR,
    spans: [{ cable: 'g652d-loose-12', lengthM: 9400 }], splices: 0, connectors: 0 }, registry);
  close(nineFour.odnLossDb, 3.29, 0.001, 'ODN loss at 9.4 km');
  close(nineFour.headroomDb, 3.01, 0.001, 'headroom at 9.4 km');
  assert.strictEqual(nineFour.verdict, 'marginal');

  // 9.5 km x 0.35 = 3.325 dB -> 2.97 dB of headroom, back under the margin
  const nineFive = budget.pointToPoint({ headEnd: LR, cpe: LR,
    spans: [{ cable: 'g652d-loose-12', lengthM: 9500 }], splices: 0, connectors: 0 }, registry);
  close(nineFive.headroomDb, 2.98, 0.001, 'headroom at 9.5 km');
  assert.strictEqual(nineFive.verdict, 'fail');
});

test('the launch ceiling sits on the receiver maximum, so a short span needs no pad', function () {
  // 2 km x 0.35 = 0.7 dB, launched at the +2.0 dBm ceiling -> 1.3 dBm at a receiver that tolerates 2.0
  const two = budget.pointToPoint({ headEnd: LR, cpe: LR, txDbm: 2,
    spans: [{ cable: 'g652d-loose-12', lengthM: 2000 }], splices: 0, connectors: 0 }, registry);
  close(two.rxPowerDbm, 1.3, 0.001, 'receive power at 2 km');
  assert.strictEqual(two.attenuator, null);
});

test('25 km is refused on reach even before the loss budget is asked', function () {
  const far = budget.pointToPoint({ headEnd: LR, cpe: LR,
    spans: [{ cable: 'g652d-loose-12', lengthM: 25000 }], splices: 5, connectors: 2 }, registry);
  // 25 km x 0.35 = 8.75, + 0.5 (5 splices) + 0.6 (2 connector pairs) = 9.85 dB against a 6.3 dB budget
  close(far.odnLossDb, 9.85, 0.001, 'ODN loss at 25 km');
  assert.strictEqual(far.verdict, 'fail');
  assert.ok(far.reasons.join(' ').indexOf('the shorter optic reaches 10000 m') !== -1, far.reasons.join(' '));
});

done();
