'use strict';
// The 100G ladder was single-lambda at 2 km (FR1) and 10 km (LR1) and then jumped straight to the four-lane
// ER4 at 40 km. A 20-30 km span therefore had no single-carrier row: it was quoted on four LAN-WDM EMLs,
// budgeted at the "top lane", which is a BOM nobody buys for a 25 km crossing. IEEE 802.3cn-2019 /
// 100G Lambda MSA define 100GBASE-ER1-30 for exactly that rung. These assertions pin the class figures and,
// more usefully, pin the two verdicts a designer gets wrong: the row reads MARGINAL at its own full reach
// (the class is 14.7 dB and ok needs margin + 2), and it OVERDRIVES the far end on any span under about
// 9 dB because the launch floor sits above the receive maximum.
const { test, assert, done } = require('./harness');
const engine = require('../engine');
const parts = require('../engine/parts');

const registry = parts.createRegistry();
const budget = engine.budget;
const ER1 = { model: 'qsfp28-100g-er1-30km' };
const LR1 = { model: 'qsfp28-100g-lr1-10km' };

function link(pair, lengthM) {
  return budget.pointToPoint({
    headEnd: pair,
    cpe: pair,
    spans: [{ cable: 'g652d-loose-12', lengthM: lengthM }],
    connectors: 0,
    splices: 0
  }, registry);
}

test('ER1-30 carries its class figures, not one module reading', function () {
  // 100G Lambda MSA 100G-ER1-30 Rev 1.1: launch 0.0..+5.6 dBm, average receive -14.7..-3.4 dBm,
  // 1304.5-1317.5 nm, 30 km. Precision Optical PRE-QSFP28-ER1-30 and Gigalight GQS-SPO101-ES1CA
  // print the same launch and receive pair; Huawei 02314VQB prints it a third time.
  const er1 = registry.get('transceiver', 'qsfp28-100g-er1-30km');
  assert.strictEqual(er1.speedMbps, 100000, 'one 100G service, not two');
  assert.strictEqual(er1.wavelengthNm, 1310, 'one carrier at 1310 nm, a window every cable here publishes');
  assert.strictEqual(er1.reachM, 30000, 'ER1-30 is the 30 km rung');
  assert.strictEqual(er1.txPowerDbmMin, 0, 'average launch MIN is 0.0 dBm');
  assert.strictEqual(er1.txPowerDbmMax, 5.6, 'average launch MAX is +5.6 dBm');
  assert.strictEqual(er1.rxSensitivityDbm, -14.7, 'average receive MIN, not the -12.5 dBm OMAouter sensitivity');
  assert.strictEqual(er1.rxOverloadDbm, -3.4, 'average receive MAX is -3.4 dBm');
  assert.ok(/^https:\/\//.test(er1.sourceUrl), er1.sourceUrl);
  assert.ok(er1.notes.indexOf('replace the row with the module actually purchased') !== -1, er1.notes);
});

test('ER1-30 reads ok at 20-25 km, which the 10 km single-lambda row cannot reach', function () {
  // 20 km x 0.35 = 7.0 dB; 14.7 - 7.0 = 7.7 dB of headroom, and ok needs margin + 2 = 5.
  const twenty = link(ER1, 20000);
  assert.strictEqual(twenty.odnLossDb, 7, '20 km of G.652.D at 0.35 dB/km');
  assert.strictEqual(twenty.headroomDb, 7.7);
  assert.strictEqual(twenty.verdict, 'ok');
  // 25 km x 0.35 = 8.75 dB; 14.7 - 8.75 = 5.95 dB, still ok.
  const twentyFive = link(ER1, 25000);
  assert.strictEqual(twentyFive.headroomDb, 5.95);
  assert.strictEqual(twentyFive.verdict, 'ok');
  // The same 25 km on the 10 km single-lambda row: 6.3 - 8.75 = -2.45 dB, fail. That gap is why the row exists.
  assert.strictEqual(link(LR1, 25000).headroomDb, -2.45);
  assert.strictEqual(link(LR1, 25000).verdict, 'fail');
});

test('ER1-30 is marginal at its own full reach: a 14.7 dB class is not a promise about 30 km', function () {
  // 30 km x 0.35 = 10.5 dB; 14.7 - 10.5 = 4.2 dB, under the 5 dB that ok needs but above the 3 dB margin.
  const thirty = link(ER1, 30000);
  assert.strictEqual(thirty.odnLossDb, 10.5);
  assert.strictEqual(thirty.headroomDb, 4.2);
  assert.strictEqual(thirty.verdict, 'marginal');
  // The last length that still reads ok: 14.7 - 5 = 9.7 dB of loss, 9.7 / 0.35 = 27.7 km.
  assert.strictEqual(link(ER1, 27700).headroomDb, 5.01);
  assert.strictEqual(link(ER1, 27700).verdict, 'ok');
  // Past 30 km the reach verdict fails first, not the receiver.
  const far = link(ER1, 33400);
  assert.strictEqual(far.verdict, 'fail');
  assert.ok(far.reasons.some(function (r) { return r.indexOf('shorter optic reaches 30000 m') !== -1; }), JSON.stringify(far.reasons));
});

test('ER1-30 overdrives the far end on a short span: its launch floor is above its receive maximum', function () {
  // Launch floor 0.0 dBm against a -3.4 dBm receive maximum: 0 - (-3.4) = 3.4 dB of loss is the minimum,
  // and at the 5.6 dBm ceiling 5.6 - (-3.4) = 9.0 dB. A 1 m pair has none of it.
  const bare = link(ER1, 1);
  assert.strictEqual(bare.verdict, 'fail');
  assert.ok(bare.reasons.some(function (r) { return r.indexOf('overload') !== -1; }), JSON.stringify(bare.reasons));
  assert.ok(bare.attenuator, 'the verdict must name the pad, not more reach');
  assert.strictEqual(bare.attenuator.padDb, 9, '5.6 - (-3.4) = 9.0 dB at the top of the window');
});

done();
