'use strict';
// The catalogue stopped at 100G. A 400G site-to-site service therefore had to be modelled as four
// 100GBASE-LR4 rows, which charges four duplex pairs and four modules for one service - a BOM error
// that no optical verdict would ever flag, because every one of the four links budgets correctly.
// These two rows are the 400G rung: 400GBASE-FR4 (802.3cu, 2 km) and 400GBASE-LR4-6 (802.3cu, 6 km,
// module declared to 10 km), both on four CWDM lanes over ONE duplex pair.
// Figures: Cisco 400G QSFP-DD data sheet, optical specifications table (QDD-400G-FR4-S, QDD-400G-LR4-S).
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

function link(model, lengthM) {
  return budget.pointToPoint({
    headEnd: { model: model },
    cpe: { model: model },
    spans: lengthM === 0 ? [] : [{ cable: 'g652d-loose-12', lengthM: lengthM }],
    connectors: { model: 'sc-apc', count: 2 }
  }, registry);
}

test('the 400GBASE-FR4 row publishes what its datasheet prints', function () {
  const fr4 = registry.get('transceiver', 'qsfp-dd-400g-fr4-2km');
  assert.strictEqual(fr4.speedMbps, 400000, 'a 400G optic');
  assert.strictEqual(fr4.wavelengthNm, 1310, 'four CWDM lanes, budgeted at 1310 nm');
  assert.strictEqual(fr4.reachM, 2000, 'QDD-400G-FR4-S is 2 km');
  assert.strictEqual(fr4.txPowerDbmMin, -3.2, 'average launch power MIN per lane');
  assert.strictEqual(fr4.txPowerDbmMax, 3.5, 'average launch power MAX per lane');
  assert.strictEqual(fr4.rxSensitivityDbm, -7.3, 'average receive power MIN per lane');
  assert.strictEqual(fr4.rxOverloadDbm, 3.5, 'average receive power MAX per lane');
  assert.ok(/^https:\/\//.test(fr4.sourceUrl), fr4.sourceUrl);
});

test('the 400GBASE-LR4 row publishes what its datasheet prints', function () {
  const lr4 = registry.get('transceiver', 'qsfp-dd-400g-lr4-10km');
  assert.strictEqual(lr4.speedMbps, 400000);
  assert.strictEqual(lr4.reachM, 10000, 'the module declares 10 km; the 802.3cu class is 6 km');
  assert.strictEqual(lr4.txPowerDbmMin, -2.7);
  assert.strictEqual(lr4.txPowerDbmMax, 5.1);
  assert.strictEqual(lr4.rxSensitivityDbm, -9);
  assert.strictEqual(lr4.rxOverloadDbm, 5.1);
  assert.ok(/^https:\/\//.test(lr4.sourceUrl), lr4.sourceUrl);
});

test('a 2 km 400GBASE-FR4 run is refused on the default margin, and needs no pad', function () {
  // Budget -3.2 - (-7.3) = 4.1 dB. 2 km x 0.35 = 0.70 dB of fibre + 2 SC/APC matings at 0.3 = 1.3 dB.
  // Received -3.2 - 1.3 = -4.5 dBm; headroom -4.5 - (-7.3) = 2.8 dB, under the 3 dB default -> fail.
  const r = link('qsfp-dd-400g-fr4-2km', 2000);
  close(r.budgetDb, 4.1, 0.001, 'the class is 4 dB, plus the 0.1 dB the sheet prints over the standard floor');
  close(r.odnLossDb, 1.3, 0.001, '0.70 dB fibre + 0.6 dB connectors');
  close(r.rxPowerDbm, -4.5, 0.001, 'receive power at 2 km');
  close(r.headroomDb, 2.8, 0.001, 'headroom against -7.3 dBm');
  assert.strictEqual(r.verdict, 'fail', 'the declared reach does not clear the default margin');
  // The launch ceiling and the receive maximum are both +3.5 dBm, so there is no overload band:
  // a 0 m patch loses 0.6 dB and lands at -3.8 dBm, inside the window.
  const bare = link('qsfp-dd-400g-fr4-2km', 0);
  assert.strictEqual(bare.attenuator, null, 'FR4 needs no attenuator - unlike 40GBASE-ER4');
  close(bare.rxPowerDbm, -3.8, 0.001, 'two matings at the launch floor');
  assert.strictEqual(bare.verdict, 'marginal', '3.5 dB of headroom: inside the margin, short of the 5 dB ok line');
});

test('1.4 km is the last 400GBASE-FR4 length that clears the default margin', function () {
  // 4.1 dB class - 3.0 dB margin - 0.6 dB of matings = 0.5 dB of fibre = 1.43 km at 0.35 dB/km.
  // 1.4 km: 0.49 + 0.6 = 1.09 dB ODN, 4.1 - 1.09 = 3.01 dB of headroom.
  const at1400 = link('qsfp-dd-400g-fr4-2km', 1400);
  close(at1400.headroomDb, 3.01, 0.001, '1.4 km is inside the margin');
  // 1.45 km: 0.5075 + 0.6 = 1.1075 dB ODN, 4.1 - 1.1075 = 2.99 dB - under the margin.
  const at1450 = link('qsfp-dd-400g-fr4-2km', 1450);
  assert.ok(at1450.headroomDb < 3, '1.45 km is over the margin: ' + at1450.headroomDb);
  assert.strictEqual(at1450.verdict, 'fail');
});

test('a 10 km 400GBASE-LR4 run fails the margin, its 6 km class reach is marginal', function () {
  // Budget -2.7 - (-9.0) = 6.3 dB, the IL column of the same table.
  // 10 km: 3.5 dB fibre + 0.6 dB matings = 4.1 dB ODN, received -6.8 dBm, headroom 2.2 dB.
  const ten = link('qsfp-dd-400g-lr4-10km', 10000);
  close(ten.budgetDb, 6.3, 0.001, '6.3 dB class');
  close(ten.odnLossDb, 4.1, 0.001, '3.5 dB fibre + 0.6 dB connectors');
  close(ten.headroomDb, 2.2, 0.001, 'headroom at the declared 10 km');
  assert.strictEqual(ten.verdict, 'fail');
  // 6 km: 2.1 dB fibre + 0.6 dB matings = 2.7 dB ODN, headroom 3.6 dB -> marginal, inside the margin.
  const six = link('qsfp-dd-400g-lr4-10km', 6000);
  close(six.headroomDb, 3.6, 0.001, 'the IEEE class reach clears the margin by 0.6 dB');
  assert.strictEqual(six.verdict, 'marginal');
});

test('7.7 km is the last 400GBASE-LR4 length that clears the default margin', function () {
  // 6.3 - 3.0 - 0.6 = 2.7 dB of fibre = 7.71 km at 0.35 dB/km. 7.7 km reads 3.01 dB, 7.8 km 2.97.
  const at7700 = link('qsfp-dd-400g-lr4-10km', 7700);
  close(at7700.headroomDb, 3.01, 0.01, 'inside the margin');
  const at7800 = link('qsfp-dd-400g-lr4-10km', 7800);
  assert.ok(at7800.headroomDb < 3, 'over the margin: ' + at7800.headroomDb);
  // A bare pair reads 5.7 dB and is 'ok' - and, with the receive maximum equal to the launch
  // ceiling, no attenuator is proposed.
  const bare = link('qsfp-dd-400g-lr4-10km', 0);
  assert.strictEqual(bare.attenuator, null, 'no pad on a 400G LR4 pair');
  close(bare.headroomDb, 5.7, 0.001, '-2.7 - 0.6 = -3.3 dBm into -9.0');
  assert.strictEqual(bare.verdict, 'ok');
});

done();
