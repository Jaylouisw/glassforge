'use strict';
// The catalogue's 2 km 100G rung was FR1 only - a single 100G PAM4 lane with a 4.0 dB class, which the
// default 3 dB margin turns into a `fail` at its own declared distance (test/parts-100g-single-lambda).
// 100GBASE-CWDM4 is the installed-base 2 km part: four 25.78G lanes on the CWDM grid, one duplex LC
// pair, and the 100G CWDM4 MSA prints a 5 dB channel insertion loss. One decibel is the whole point of
// the row - it is the difference between a compliant 2 km campus link reading `marginal` and reading
// `fail` - so these assertions pin the MSA figures *and* drive the engine to the verdicts.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const parts = require('../engine/parts');

const registry = parts.createRegistry();
const budget = engine.budget;
const CWDM4 = { model: 'qsfp28-100g-cwdm4-2km' };
const FR1 = { model: 'qsfp28-100g-fr1-2km' };

function link(optic, lengthM, connectors) {
  return budget.pointToPoint({
    headEnd: optic,
    cpe: optic,
    spans: [{ cable: 'g652d-loose-12', lengthM: lengthM }],
    connectors: connectors === undefined ? 2 : connectors,
    splices: 0
  }, registry);
}

test('the CWDM4 row carries the launch and receive figures of MSA tables 2-3 and 2-4', function () {
  const part = registry.get('transceiver', 'qsfp28-100g-cwdm4-2km');
  assert.strictEqual(part.speedMbps, 100000, 'CWDM4 is a 100G optic');
  assert.strictEqual(part.wavelengthNm, 1310, 'one window the cables publish, standing in for 1271-1331 nm');
  assert.strictEqual(part.reachM, 2000, 'MSA table 4-1: operating distance 2 km');
  assert.strictEqual(part.txPowerDbmMin, -6.5, 'average launch MIN is -6.5 dBm');
  assert.strictEqual(part.txPowerDbmMax, 2.5, 'average launch MAX is +2.5 dBm');
  assert.strictEqual(part.rxSensitivityDbm, -11.5, 'average receive MIN is -11.5 dBm');
  assert.strictEqual(part.rxOverloadDbm, 2.5, 'average receive MAX is +2.5 dBm');
  assert.strictEqual(part.polish, 'upc', 'duplex LC/UPC, the blue latch');
  assert.ok(/^https:\/\//.test(part.sourceUrl), part.sourceUrl);
  assert.ok(part.notes.indexOf('FEC') !== -1, 'the row must say the class needs FEC: ' + part.notes);
  assert.ok(part.notes.indexOf('replace the row with the module actually purchased') !== -1, part.notes);
});

test('the budget is the MSA channel insertion loss, -6.5 minus -11.5 = 5.0 dB', function () {
  // MSA table 4-1: channel insertion loss (max) 5 dB over 1264.5-1337.5 nm. The launch floor minus
  // the receive floor equals it exactly, so nothing here is inferred from a "power budget" figure.
  const backToBack = link(CWDM4, 0, 0);
  close(backToBack.budgetDb, 5.0, 0.001, 'launch -6.5 minus receive -11.5');
  close(backToBack.headroomDb, 5.0, 0.001, 'a bare 5.0 dB member with no connectors spends nothing');
  assert.strictEqual(backToBack.verdict, 'ok', '5.0 dB is the first headroom the ok band accepts (margin 3 + 2)');
});

test('at its declared 2 km the row is marginal where FR1 fails - the reason it exists', function () {
  // 2 km x 0.35 dB/km = 0.70 dB of fibre, 2 x sc-apc 0.3 = 0.60 dB of connectors -> 1.30 dB of ODN.
  // CWDM4: 5.0 - 1.30 = 3.70 dB of headroom -> inside the class, marginal (under margin + 2).
  // FR1:   4.0 - 1.30 = 2.70 dB -> under the 3 dB margin, fail.
  const cwdm4 = link(CWDM4, 2000);
  close(cwdm4.odnLossDb, 1.3, 0.001, '2 km of G.652.D plus both patch pairs');
  close(cwdm4.headroomDb, 3.7, 0.001, '5.0 - 1.30');
  assert.strictEqual(cwdm4.verdict, 'marginal', 'a compliant 2 km link with real patch cords');
  const fr1 = link(FR1, 2000);
  close(fr1.headroomDb, 2.7, 0.001, '4.0 - 1.30');
  assert.strictEqual(fr1.verdict, 'fail', 'the same span on the 1 dB tighter class');
});

test('1 km and a back-to-back pair are marginal too: a 5 dB class sits 2 dB above the margin', function () {
  // 1 km: 0.35 + 0.60 = 0.95 dB -> 4.05 dB of headroom. Back-to-back with both patch cords: 0.60 dB
  // -> 4.40 dB. Both read marginal because `verdictFor` wants margin + 2 = 5.0 dB for `ok`.
  const oneKm = link(CWDM4, 1000);
  close(oneKm.headroomDb, 4.05, 0.001, '5.0 - 0.95');
  assert.strictEqual(oneKm.verdict, 'marginal', '4.05 dB of headroom');
  const patchOnly = link(CWDM4, 0);
  close(patchOnly.headroomDb, 4.4, 0.001, '5.0 - 0.60');
  assert.strictEqual(patchOnly.verdict, 'marginal', '4.40 dB of headroom');
});

test('past 2 km the row fails by name on reach, not on loss', function () {
  // 2.1 km: 0.735 + 0.60 = 1.335 dB of ODN, so 3.67 dB of headroom is still inside the class - the
  // refusal has to be the MSA distance (2000 m), and it has to say so.
  const over = link(CWDM4, 2100);
  close(over.headroomDb, 3.67, 0.001, 'loss is not the problem at 2.1 km');
  assert.strictEqual(over.verdict, 'fail');
  assert.ok(over.reasons.some(function (r) { return r.indexOf('2000 m') !== -1; }), JSON.stringify(over.reasons));
});

test('receive overload equals launch ceiling, so the row never needs an attenuator', function () {
  // MSA: average launch max +2.5 dBm, average receive max +2.5 dBm -> a 0 dB class floor. A pad here
  // would cost 1 dB of a 5 dB class, so the row must never ask for one.
  const part = registry.get('transceiver', 'qsfp28-100g-cwdm4-2km');
  assert.strictEqual(part.rxOverloadDbm, part.txPowerDbmMax, '0 dB between launch ceiling and overload');
  const pad = link(CWDM4, 0).attenuator;
  assert.strictEqual(pad, null, 'back-to-back needs no attenuator, got ' + JSON.stringify(pad));
});

done();
