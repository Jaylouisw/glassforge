'use strict';
// The 100GBASE-ER4 row's budget is its launch FLOOR minus its sensitivity, and the row printed that
// subtraction with the ceiling - 2.9 - (-20.9) - which is 23.8 dB, not the 18.0 dB Clause 88 gives.
// A reader who budgets 23.8 dB plans a span that cannot be lit, and the engine's own arithmetic is
// the check: 18.0 is what `pointToPoint` derives from the two fields. This suite pins that identity
// and the three verdicts a 40 km rung is easy to get wrong - a bare 40 km run is marginal and not ok,
// two patch panels turn it into a headroom fail, and the class's loose 4.5 dBm receive maximum (loose
// so an ER4 receiver still takes an LR4 transmitter at short reach) is why a short span needs no pad.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;
const ER4 = { model: 'qsfp28-100g-er4-40km' };

test('the ER4 row carries IEEE Clause 88 numbers and says where they came from', function () {
  const er4 = registry.get('transceiver', 'qsfp28-100g-er4-40km');
  assert.strictEqual(er4.vendor, 'generic');
  assert.strictEqual(er4.speedMbps, 100000);
  assert.strictEqual(er4.wavelengthNm, 1310);
  assert.strictEqual(er4.reachM, 40000);
  // Clause 88 Table 88-7 / 88-8, per lane: launch -2.9..+2.9 dBm, average receive -20.9..+4.5 dBm.
  assert.strictEqual(er4.txPowerDbmMin, -2.9);
  assert.strictEqual(er4.txPowerDbmMax, 2.9);
  assert.strictEqual(er4.rxSensitivityDbm, -20.9);
  assert.strictEqual(er4.rxOverloadDbm, 4.5);
  assert.ok(/^https:\/\//.test(er4.sourceUrl), er4.sourceUrl);

  // The ER4 ceiling is below LR4's 4.5 dBm - that six-dB-of-total difference is the class, and the
  // QSFP28 sheets that print 4.5 for an ER4 are printing LR4's pair.
  const lr4 = registry.get('transceiver', 'qsfp28-100g-lr4-10km');
  assert.strictEqual(lr4.txPowerDbmMax, 4.5);
  assert.ok(er4.txPowerDbmMax < lr4.txPowerDbmMax, 'ER4 ceiling must sit under LR4s');
});

test('the note prints the budget as the launch floor minus the sensitivity, not the ceiling', function () {
  const er4 = registry.get('transceiver', 'qsfp28-100g-er4-40km');
  // -2.9 - (-20.9) = 18.0 dB; the ceiling against the same receiver is 23.8 dB and is not the class.
  assert.ok(er4.notes.indexOf('-2.9 - (-20.9) = 18.0') !== -1, er4.notes);
  // The false identity, as an equation, is what the correction removed. The lookbehind matters:
  // '-2.9 - (-20.9) = 18.0' contains the substring '2.9 - (-20.9) = 18.0', so a plain `indexOf`
  // matches the corrected sentence and can never fail for the right reason.
  assert.ok(!/(?:^|[^-])2\.9 - \(-20\.9\) = 18\.0/.test(er4.notes), 'the ceiling identity is back in the note');
  assert.ok(er4.notes.indexOf('replace the row with the part actually purchased') !== -1, er4.notes);
});

test('a bare 40 km run is marginal on its own margin, not ok', function () {
  const at40 = budget.pointToPoint({ headEnd: ER4, cpe: ER4,
    spans: [{ cable: 'g652d-loose-12', lengthM: 40000 }], splices: 0, connectors: 0 }, registry);
  // 40 km x 0.35 dB/km = 14.0 dB; budget -2.9 - (-20.9) = 18.0 dB -> 4.0 dB of headroom.
  close(at40.odnLossDb, 14, 0.001, 'ODN loss at 40 km');
  close(at40.budgetDb, 18, 0.001, 'link budget is the launch floor minus sensitivity');
  close(at40.headroomDb, 4, 0.001, 'headroom at 40 km');
  // ok needs margin + 2 = 5 dB; 4.0 dB is inside the marginal band.
  assert.strictEqual(at40.verdict, 'marginal');
  assert.strictEqual(at40.reasons.length, 0, at40.reasons);
});

test('ten splices hold 3.0 dB and still read marginal; two patch panels fail it', function () {
  const spliced = budget.pointToPoint({ headEnd: ER4, cpe: ER4,
    spans: [{ cable: 'g652d-loose-12', lengthM: 40000 }], splices: 10, connectors: 0 }, registry);
  // 14.0 + 10 x 0.1 = 15.0 dB -> 3.0 dB, the default margin exactly.
  close(spliced.odnLossDb, 15, 0.001, 'ODN loss with ten splices');
  close(spliced.headroomDb, 3, 0.001, 'headroom with ten splices');
  assert.strictEqual(spliced.verdict, 'marginal');

  const patched = budget.pointToPoint({ headEnd: ER4, cpe: ER4,
    spans: [{ cable: 'g652d-loose-12', lengthM: 40000 }], splices: 10, connectors: 2 }, registry);
  // 15.0 + 2 x 0.3 (sc-apc) = 15.6 dB -> 2.4 dB, under the 3 dB margin.
  close(patched.odnLossDb, 15.6, 0.001, 'ODN loss with two patch panels');
  close(patched.headroomDb, 2.4, 0.001, 'headroom with two patch panels');
  assert.strictEqual(patched.verdict, 'fail');
  assert.ok(patched.reasons.join(' ').indexOf('design margin') !== -1, patched.reasons);
});

test('a short span needs no pad at the class receive maximum', function () {
  const at1 = budget.pointToPoint({ headEnd: ER4, cpe: ER4,
    spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }], splices: 0, connectors: 0 }, registry);
  // 1 km x 0.35 = 0.35 dB; -2.9 - 0.35 = -3.25 dBm against a +4.5 dBm overload point.
  close(at1.rxPowerDbm, -3.25, 0.001, 'receive power at 1 km');
  assert.strictEqual(at1.attenuator, null, 'the class row asks for no pad');
  assert.strictEqual(at1.launchWindowPad, null, 'and none at the top of the launch window either');
  assert.strictEqual(at1.verdict, 'ok');
});

done();
