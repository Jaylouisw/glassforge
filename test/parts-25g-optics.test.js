'use strict';
// 25GBASE-ER is the 40 km rung between 25GBASE-LR (10 km) and the 10GBASE-ER/ZR long-reach rows.
// Its figures come from IEEE 802.3cc Tables 114-6 and 114-7, and the row is only usable if the
// engine reads the same class budget the standard names: 18 dB of channel insertion loss.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

function link(lengthM, extra) {
  return Object.assign({
    headEnd: { model: 'sfp28-25g-er-40km' },
    cpe: { model: 'sfp28-25g-er-40km' },
    spans: [{ cable: 'g652d-loose-12', lengthM: lengthM }],
    connectors: { model: 'sc-apc', count: 2 }
  }, extra || {});
}

test('the 25GBASE-ER row publishes the launch and receive figures of 802.3cc', function () {
  // Table 114-6: average launch power -3.0..+6.0 dBm in the 1295-1310 nm window.
  // Table 114-7: average receive power -21.0 (min) .. -4.0 (max) dBm.
  const er = registry.get('transceiver', 'sfp28-25g-er-40km');
  assert.strictEqual(er.speedMbps, 25000, '25GBASE-ER is a 25G optic');
  assert.strictEqual(er.wavelengthNm, 1310, 'the class lane window is 1295-1310 nm');
  assert.strictEqual(er.reachM, 40000, '25GBASE-ER reaches 40 km, not 10');
  assert.strictEqual(er.txPowerDbmMin, -3, 'average launch power MIN is -3.0 dBm');
  assert.strictEqual(er.txPowerDbmMax, 6, 'average launch power MAX is +6.0 dBm');
  assert.strictEqual(er.rxSensitivityDbm, -21, 'average receive power MIN is -21.0 dBm');
  assert.strictEqual(er.rxOverloadDbm, -4, 'average receive power MAX is -4.0 dBm');
});

test('a 40 km 25GBASE-ER link spends 14.6 dB of an 18 dB class and stays audible', function () {
  // 40 km x 0.35 dB/km = 14.0 dB of fibre, plus two SC/APC matings at 0.3 dB = 14.6 dB ODN.
  // Budget -3.0 - (-21.0) = 18 dB; headroom 18 - 14.6 = 3.4 dB, which is inside the class but
  // below the 5 dB the engine calls 'ok', so the verdict is marginal rather than ok or fail.
  const r = budget.pointToPoint(link(40000), registry);
  assert.strictEqual(r.budgetDb, 18, 'the pair can afford 18 dB');
  assert.strictEqual(r.odnLossDb, 14.6, '14.0 dB fibre + 0.6 dB connectors');
  assert.strictEqual(r.rxPowerDbm, -17.6, '-3.0 dBm launched into 14.6 dB');
  assert.strictEqual(r.headroomDb, 3.4, '4 dB above the -21.0 dBm sensitivity');
  assert.strictEqual(r.verdict, 'marginal', 'inside the class, under the 5 dB ok floor');
});

test('a bare 25GBASE-ER patch is over the receiver overload point and the pad fits', function () {
  // Two optics patched together lose 0.6 dB: -3.0 - 0.6 = -3.6 dBm at a -4.0 dBm receiver.
  // Overload is the one fault more reach cannot fix, so the budget has to name the pad.
  const r = budget.pointToPoint(link(0), registry);
  assert.strictEqual(r.rxPowerDbm, -3.6, 'two SC/APC matings only');
  assert.ok(r.attenuator, 'a pad is required');
  assert.strictEqual(r.attenuator.padDb, 1, '0.4 dB over overload rounds up to a 1 dB pad');
  assert.strictEqual(r.attenuator.fits, true, 'the 13 dB of spare class still funds it');
  assert.strictEqual(r.verdict, 'fail', 'an overload without a pad is not a pass');
});

test('a mixed ER/LR pair is held to the shorter optic, not refused on optics', function () {
  // Both rows are recorded at 1310 nm - LR's window is 1295-1325 nm and ER's is 1295-1310 nm, but
  // the catalogue models one wavelength per optic - so the wavelength check cannot tell the classes
  // apart and the pair is accepted. What refuses the 40 km span is the LR row's 10 km reach; the
  // budget is the LR receiver's 10.3 dB (-3.0 launch into -13.3 dBm), not the ER class's 18 dB.
  // This asserts the limit of the model rather than a refusal that does not happen.
  const r = budget.pointToPoint({
    headEnd: { model: 'sfp28-25g-er-40km' },
    cpe: { model: 'sfp28-25g-lr-10km' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 40000 }],
    connectors: { model: 'sc-apc', count: 2 }
  }, registry);
  assert.strictEqual(r.budgetDb, 10.3, '10.3 dB is the LR receiver, not the ER class');
  assert.strictEqual(r.reachM, 10000, 'the shorter optic sets the reach');
  assert.strictEqual(r.verdict, 'fail', '40 km is outside the LR row, so the pair is refused by reach');
  assert.ok(r.reasons.some(function (why) { return why.indexOf('reaches 10000 m') !== -1; }),
    'the refusal names the reach: ' + r.reasons.join(' | '));
});

done();
