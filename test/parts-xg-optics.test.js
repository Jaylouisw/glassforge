'use strict';
// `xg-pon` is a first-class PON type in the engine - PON_TYPES lists it and CLASS_BUDGET_DB carries
// its N1 (29 dB) and N2 (31 dB) rows - but the catalogue held no XG-PON OLT and no XG-PON ONT, so
// every xg-pon design died on "unknown olt model" and the two class rows were unreachable. These
// assertions pin the new parts to ITU-T G.987.2, so the class a part claims stays reachable.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');
const parts = require('../engine/parts');

const registry = parts.createRegistry();
const budget = engine.budget;

test('the XG-PON optics publish the launch and receive figures of G.987.2', function () {
  // Table 9-3 (9.95328 Gbit/s downstream): OLT mean launched power MIN +2.0 dBm (N1) / +4.0 dBm
  // (N2a), MAX +6.0 / +8.0; ONU sensitivity -28.0 dBm and overload -8.0 dBm for both classes.
  // Table 9-4 (2.48832 Gbit/s upstream): ONU mean launch +2.0..+7.0 dBm for every class; OLT
  // receiver sensitivity -27.5 dBm (N1) / -29.5 dBm (N2), overload -7.0 / -9.0 dBm.
  const n1 = registry.get('olt', 'xg-pon-n1-16');
  assert.strictEqual(n1.txPowerDbmMin, 2, 'N1 launch MIN is +2.0 dBm');
  assert.strictEqual(n1.txPowerDbmMax, 6, 'N1 launch MAX is +6.0 dBm');
  assert.strictEqual(n1.rxSensitivityDbm, -27.5, 'N1 OLT receiver sensitivity is -27.5 dBm');
  assert.strictEqual(n1.rxOverloadDbm, -7, 'N1 OLT receiver overload is -7.0 dBm');

  const n2 = registry.get('olt', 'xg-pon-n2-16');
  assert.strictEqual(n2.txPowerDbmMin, 4, 'N2a launch MIN is +4.0 dBm, not 2');
  assert.strictEqual(n2.txPowerDbmMax, 8, 'N2a launch MAX is +8.0 dBm');
  assert.strictEqual(n2.rxSensitivityDbm, -29.5, 'N2 OLT receiver sensitivity is -29.5 dBm');
  assert.strictEqual(n2.rxOverloadDbm, -9, 'N2 OLT receiver overload is -9.0 dBm');

  const ont = registry.get('ont', 'xg-pon-ont-1xge');
  assert.strictEqual(ont.txPowerDbmMin, 2, 'ONU mean launch MIN is +2.0 dBm');
  assert.strictEqual(ont.txPowerDbmMax, 7, 'ONU mean launch MAX is +7.0 dBm');
  assert.strictEqual(ont.rxSensitivityDbm, -28, 'ONU sensitivity is -28.0 dBm for both classes');
  assert.strictEqual(ont.rxOverloadDbm, -8, 'ONU overload is -8.0 dBm');
});

test('an XG-PON OLT claims the class budget the engine publishes for it', function () {
  // A part whose budgetDb drifts from the table is a part the validator warns about, and a warning
  // fails parts-registry's "the shipped catalogue validates" assertion - but name the trap here too.
  assert.strictEqual(parts.classBudgetDb('xg-pon', 'N1'), 29);
  assert.strictEqual(parts.classBudgetDb('xg-pon', 'N2'), 31);
  assert.strictEqual(registry.get('olt', 'xg-pon-n1-16').budgetDb, 29);
  assert.strictEqual(registry.get('olt', 'xg-pon-n2-16').budgetDb, 31);
});

test('a 1:64 XG-PON at class N2 budgets green', function () {
  // 1.0 km of G.652.D at 1490 nm = 0.22; 2 splices = 0.20; 2 connectors = 0.60;
  // 1:64 splitter = 10*log10(64) = 18.06 split + 2.44 excess = 20.50  ->  ODN 21.52 dB.
  // N2a launches 4.0 dBm: 4.0 - 21.52 = -17.52 dBm into a -28 dBm ONT = 10.48 dB of headroom,
  // and 31 - 21.52 = 9.48 dB inside the class budget.
  const r = budget.opticalBudget({
    olt: { model: 'xg-pon-n2-16' },
    ont: { model: 'xg-pon-ont-1xge' },
    wavelength: '1490',
    spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }],
    splitters: [{ model: 'plc-1x64-sca' }],
    splices: 2,
    connectors: 2
  }, registry);
  close(r.odnLossDb, 21.52, 0.001, 'ODN loss');
  close(r.rxPowerDbm, -17.52, 0.01, 'receive power');
  close(r.headroomDb, 10.48, 0.01, 'headroom');
  close(r.classHeadroomDb, 9.48, 0.01, 'class headroom');
  assert.strictEqual(r.cascadeRatio, 64);
  assert.strictEqual(r.verdict, 'ok', r.reasons.join(' | '));
});

test('a short run on an N2 port is an attenuator job, not a pass', function () {
  // G.987.2 Table 6-1 puts N2's ODN attenuation range at 16-31 dB: a 100 m patch is 0.02 dB, so the
  // ONT sees +3.98 dBm at N2's weakest launch (+4) and +7.98 dBm at its strongest (+8) - 15.98 dB
  // above the -8.0 dBm overload point. The pad is sized at the strongest launch, because that is the
  // module that may land in the chassis: this assertion used to read 12 dB, which was 11.98 taken at
  // the +4 floor and leaves the ONT at -4.02 dBm, still 3.98 dB over its overload point, on a card
  // that paints +8. The smallest pad that clears the top of the window is 16 dB, which lands it at
  // -8.02 dBm. (It is the smallest that clears the receiver, not the class's 16 dB floor - check a
  // pad against Table 6-1 before ordering it.)
  const r = budget.opticalBudget({
    olt: { model: 'xg-pon-n2-16' },
    ont: { model: 'xg-pon-ont-1xge' },
    wavelength: '1490',
    spans: [{ cable: 'g652d-loose-12', lengthM: 100 }],
    splices: 0,
    connectors: 0
  }, registry);
  assert.ok(r.attenuator, 'a 4 dBm launch into a -8 dBm receiver must report an attenuator');
  // +8 (N2 launch MAX) - 0.02 (100 m of G.652.D at 1490 nm) - (-8) = 15.98 dB of overload.
  assert.strictEqual(r.attenuator.overDb, 15.98);
  assert.strictEqual(r.attenuator.padDb, 16);
  assert.strictEqual(r.attenuator.atTxDbm, 8, 'the pad is sized for the top of the launch window');
  // The pad has to hold the receiver at every launch: +8 - 0.02 - 16 = -8.02 dBm, inside the -8 dBm
  // overload point. A 15 dB pad would leave it at -7.02 dBm, still above it.
  assert.ok(8 - r.odnLossDb - r.attenuator.padDb <= -8, 'a whole-dB pad clears the hottest launch');
  assert.ok(r.reasons.some(function (why) { return why.indexOf('overload point') !== -1; }),
    'the verdict must say why: ' + r.reasons.join(' | '));
});

test('an XG-PON OLT and a GPON ONT cannot share a PON', function () {
  throws(function () {
    budget.opticalBudget({
      olt: { model: 'xg-pon-n2-16' },
      ont: { model: 'gpon-ont-4ge' },
      spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }]
    }, registry);
  }, 'cannot share a PON', 'xg-pon OLT with a gpon ONT');
});

done();
