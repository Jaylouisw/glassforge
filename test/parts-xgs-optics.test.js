'use strict';
// The XGS-PON parts are what a 10G design is approved against, so their figures have to be the
// ones ITU-T G.9807.1 publishes - a class budget is only usable if the OLT's minimum launch power
// can actually reach the loss that class allows.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

/** The ONT a PON is best served by: the most sensitive receiver of that technology. */
function bestOnt(pon) {
  return registry.all('ont')
    .filter(function (o) { return o.pon === pon; })
    .sort(function (a, b) { return a.rxSensitivityDbm - b.rxSensitivityDbm; })[0];
}

test('an ODN at a class budget limit does not fail the receiver headroom check', function () {
  // 0.22 dB/km at 1490 nm on g652d-loose-12, so a span of (budget - 0.01)/0.22 km lands a
  // hundredth of a dB under the class limit: the failure the old figures produced was 1-3 dB of
  // headroom deficit, not float noise.
  for (const olt of registry.all('olt')) {
    const ont = bestOnt(olt.pon);
    const lengthM = ((olt.budgetDb - 0.01) / 0.22) * 1000;
    const r = budget.opticalBudget({
      olt: { model: olt.model },
      ont: { model: ont.model },
      wavelength: '1490',
      spans: [{ cable: 'g652d-loose-12', lengthM: lengthM }],
      splices: 0,
      connectors: 0
    }, registry);
    // N2: 4 dBm launch - 31 dB ODN = -27 dBm at a -28 dBm receiver -> 1 dB above sensitivity.
    // E2: 8 dBm launch - 35 dB ODN = -27 dBm at a -28 dBm receiver -> 1 dB above sensitivity.
    // A class-limit ODN is above the 3 dB design margin by definition, so the verdict is
    // 'marginal', not 'ok' - but the light must still land above the receiver's sensitivity.
    // An under-reported launch power puts it below, and the class the part claims is unreachable.
    assert.ok(r.headroomDb >= -0.02, olt.model + ' / ' + ont.model + ' at the ' + olt.class +
      ' limit: ' + r.headroomDb + ' dB of headroom (rx ' + r.rxPowerDbm + ' dBm vs sensitivity ' +
      r.sensitivityDbm + ' dBm)');
    assert.ok(!r.reasons.some(function (why) { return why.indexOf('exceeds the') !== -1; }),
      olt.model + ' ODN loss exceeds its own class budget: ' + r.reasons.join(' | '));
    assert.ok(r.classHeadroomDb >= -0.02, olt.model + ' class headroom ' + r.classHeadroomDb);
  }
});

test('the XGS-PON optics publish the launch and receive figures of G.9807.1', function () {
  // Table B.9.3 (9.95328 Gbit/s downstream): OLT mean launched power MIN +2.0/+4.0/+6.0/+8.0 dBm
  // for N1/N2/E1/E2; ONU sensitivity -28.0 dBm and overload -9.0 dBm for every class.
  // Table B.9.4 (upstream): ONU mean launch +4.0..+9.0 dBm; OLT receiver sensitivity
  // -26.0/-28.0/-30.0/-32.0 dBm and overload -5.0/-7.0/-9.0/-11.0 dBm for N1/N2/E1/E2.
  const n2 = registry.get('olt', 'xgs-pon-n2-8');
  assert.strictEqual(n2.txPowerDbmMin, 4, 'N2 launch MIN is +4.0 dBm, not 2');
  assert.strictEqual(n2.txPowerDbmMax, 7, 'N2 launch MAX is +7.0 dBm');
  assert.strictEqual(n2.rxSensitivityDbm, -28, 'N2 OLT receiver sensitivity is -28.0 dBm');
  assert.strictEqual(n2.rxOverloadDbm, -7, 'N2 OLT receiver overload is -7.0 dBm');

  const e2 = registry.get('olt', 'xgs-pon-e2-16');
  assert.strictEqual(e2.txPowerDbmMin, 8, 'E2 launch MIN is +8.0 dBm, not 4');
  assert.strictEqual(e2.txPowerDbmMax, 11, 'E2 launch MAX is +11.0 dBm');
  assert.strictEqual(e2.rxSensitivityDbm, -32, 'E2 OLT receiver sensitivity is -32.0 dBm');
  assert.strictEqual(e2.rxOverloadDbm, -11, 'E2 OLT receiver overload is -11.0 dBm');

  const ont = registry.get('ont', 'xgs-pon-ont-1xge');
  assert.strictEqual(ont.txPowerDbmMin, 4, 'ONU mean launch MIN is +4.0 dBm');
  assert.strictEqual(ont.txPowerDbmMax, 9, 'ONU mean launch MAX is +9.0 dBm');
  assert.strictEqual(ont.rxSensitivityDbm, -28, 'ONU sensitivity is -28.0 dBm for every class');
  assert.strictEqual(ont.rxOverloadDbm, -9, 'ONU overload is -9.0 dBm, not -7');
});

done();
