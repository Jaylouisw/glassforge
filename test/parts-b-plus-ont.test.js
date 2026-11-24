'use strict';
// The 4-port class B+ CPE: what a B+ line card's customers actually have on the wall. The figures
// are ITU-T G.984.2 Table A.1's class B+ limits, and the point of the row is that the receiver
// verdict for a B+ ODN is 3 dB tighter than the C+ 4-port row the catalogue used to offer alone.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

test('the B+ ONT publishes the class B+ figures of G.984.2 Table A.1', function () {
  // ONU: mean launched power +0.5..+5 dBm, minimum sensitivity -27 dBm, minimum overload -8 dBm.
  const ont = registry.get('ont', 'gpon-ont-b-plus-4ge');
  assert.strictEqual(ont.pon, 'gpon');
  assert.strictEqual(ont.txPowerDbmMin, 0.5, 'B+ ONU launch floor is +0.5 dBm');
  assert.strictEqual(ont.txPowerDbmMax, 5, 'B+ ONU launch ceiling is +5 dBm');
  assert.strictEqual(ont.rxSensitivityDbm, -27, 'B+ ONU sensitivity is -27 dBm, not the C+ -30');
  assert.strictEqual(ont.rxOverloadDbm, -8, 'B+ ONU overload is -8 dBm');
  assert.strictEqual(ont.ports.ge, 4, 'four GE ports, as the label says');
});

test('a B+ plant inside its class fails the B+ CPE margin and passes the C+ one', function () {
  // g652d-loose-12 at 0.22 dB/km, 1:64 = 20.50 dB, 20 km = 4.40, 4 fusion splices = 0.40,
  // 2 SC/APC matings = 0.60 -> ODN 25.90 dB, 2.10 dB inside the 28 dB class.
  // B+ pair: 1.5 dBm launch - (-27) = 28.5, minus 3 dB margin = 25.5, so 25.90 leaves 2.6 dB.
  // C+ CPE: 1.5 - (-30) = 31.5, minus 3 = 28.5, so 25.90 leaves 5.6 dB.
  const spans = [{ cable: 'g652d-loose-12', lengthM: 20000 }];
  const splitters = [{ model: 'plc-1x64-sca' }];
  const bPlus = budget.opticalBudget({
    olt: { model: 'gpon-b-plus-8' }, ont: { model: 'gpon-ont-b-plus-4ge' },
    wavelength: '1490', spans: spans, splitters: splitters, splices: 4, connectors: 2
  }, registry);
  const cPlus = budget.opticalBudget({
    olt: { model: 'gpon-b-plus-8' }, ont: { model: 'gpon-ont-4ge' },
    wavelength: '1490', spans: spans, splitters: splitters, splices: 4, connectors: 2
  }, registry);

  assert.strictEqual(bPlus.odnLossDb, 25.9, 'ODN 20.5 + 4.4 + 0.4 + 0.6 = 25.9 dB');
  assert.strictEqual(cPlus.odnLossDb, 25.9, 'the same plant, so the same ODN');
  assert.strictEqual(bPlus.headroomDb, 2.6, '1.5 + 27 - 25.9 = 2.6 dB of headroom');
  assert.strictEqual(cPlus.headroomDb, 5.6, '1.5 + 30 - 25.9 = 5.6 dB of headroom');
  assert.strictEqual(bPlus.verdict, 'fail', '2.6 dB is under the default 3 dB margin');
  assert.strictEqual(cPlus.verdict, 'ok', '5.6 dB clears the same margin');
  assert.ok(bPlus.reasons.some(function (why) { return why.indexOf('below the 3 dB design margin') !== -1; }),
    'the failure names the margin, not the class: ' + bPlus.reasons.join(' | '));
  assert.ok(bPlus.classHeadroomDb > 0 && cPlus.classHeadroomDb > 0,
    'both are inside the 28 dB class: ' + bPlus.classHeadroomDb + ' / ' + cPlus.classHeadroomDb);
});

test('class B+ has a 13 dB floor, so a short ODN overdrives the ONT and the pad is that floor', function () {
  // Launch ceiling +5 dBm against a -8 dBm overload point needs 13 dB of loss in front of the
  // receiver - G.984.2 lists class B+ as 13..28 dB of ODN, so the floor is the class' own.
  const r = budget.opticalBudget({
    olt: { model: 'gpon-b-plus-8' }, ont: { model: 'gpon-ont-b-plus-4ge' },
    wavelength: '1490', spans: [{ cable: 'g652d-loose-12', lengthM: 20 }], splices: 2
  }, registry);
  // 20 m at 0.22 dB/km = 0.0044, 2 fusion splices = 0.2 -> 0.20 dB ODN.
  assert.strictEqual(r.odnLossDb, 0.204, '20 m of fibre plus two splices is 0.204 dB');
  assert.strictEqual(r.verdict, 'fail', 'a bare patch into the ONT blinds it');
  assert.ok(r.attenuator && r.attenuator.padDb === 13,
    'the pad named is the 13 dB class floor: ' + JSON.stringify(r.attenuator));
  assert.ok(r.reasons.some(function (why) { return why.indexOf('overload') !== -1; }),
    'the refusal names the overload: ' + r.reasons.join(' | '));
});

done();
