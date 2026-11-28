'use strict';
// The Nokia XGS-PON pair: the first named XGS-PON CPE in the catalogue (an indoor SFU and an SFP
// ONT), and the first ONT that is a plug-in module rather than a box on a wall. The optical window
// is G.9807.1's class N ONU figures printed by the vendor, so the point of these rows is a product
// name and a form factor - not a decibel - and a short ODN is what fails them.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

test('the Nokia XGS-PON pair publishes the class N ONU window, not a better receiver', function () {
  // G.9807.1 class N ONU: +4..+9 dBm launch, -28 dBm sensitivity, -9 dBm overload.
  for (const model of ['nokia-xs-010x-q', 'nokia-xs-010s-q']) {
    const ont = registry.get('ont', model);
    assert.strictEqual(ont.pon, 'xgs-pon', model + ' is an XGS-PON ONT');
    assert.strictEqual(ont.txPowerDbmMin, 4, model + ' launch floor is +4 dBm');
    assert.strictEqual(ont.txPowerDbmMax, 9, model + ' launch ceiling is +9 dBm');
    assert.strictEqual(ont.rxSensitivityDbm, -28, model + ' sensitivity is -28 dBm');
    assert.strictEqual(ont.rxOverloadDbm, -9, model + ' overload is -9 dBm');
    assert.strictEqual(ont.ports['10ge'], 1, model + ' declares the 10G host port');
    assert.ok(/^https:\/\/onestore\.nokia\.com\//.test(ont.sourceUrl), model + ' cites Nokia: ' + ont.sourceUrl);
  }
  // The vendor prints the class, so the row must budget exactly like the generic one: 9 - (-9) = 18
  // and 4 - (-28) = 32 dB on both, and a plant that picks the Nokia row gains nothing.
  const generic = registry.get('ont', 'xgs-pon-ont-1xge');
  const nokia = registry.get('ont', 'nokia-xs-010x-q');
  assert.strictEqual(nokia.txPowerDbmMin - nokia.rxSensitivityDbm, generic.txPowerDbmMin - generic.rxSensitivityDbm,
    'the affordable loss is the class\'s 32 dB on both rows');
  assert.strictEqual(nokia.rxSensitivityDbm, generic.rxSensitivityDbm, 'and the receiver is the class receiver');
});

test('an XGS-PON ONT cannot terminate a GPON plant, by name', function () {
  assert.throws(function () {
    budget.opticalBudget({
      olt: { model: 'gpon-c-plus-8' }, ont: { model: 'nokia-xs-010x-q' },
      wavelength: '1490', spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }], splices: 0
    }, registry);
  }, /the OLT is gpon and the ONT is xgs-pon - they cannot share a PON/);
});

test('the SFP ONT is CPE, so a link end cannot be budgeted on it', function () {
  // kind `ont` is not read by the link budget, which names the transceiver models that exist.
  assert.throws(function () {
    budget.pointToPoint({ headEnd: { model: 'nokia-xs-010s-q' }, cpe: { model: 'sfp-plus-10g-lr-10km' } }, registry);
  }, /unknown transceiver model "nokia-xs-010s-q"/);
});

test('a 1 km XGS-PON tail overdrives the new ONT and the pad is 16 dB', function () {
  // 1 km of g652d-loose-12 at 1490 nm = 0.22 dB, so the +4 dBm launch floor arrives at +3.78 dBm
  // into a -9 dBm overload point. The pad is set from the OLT's 7 dBm ceiling: 7 - (-9) = 16 dB.
  const r = budget.opticalBudget({
    olt: { model: 'xgs-pon-n2-8' }, ont: { model: 'nokia-xs-010x-q' },
    wavelength: '1490', spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }], splices: 0, connectors: 0
  }, registry);
  assert.strictEqual(r.odnLossDb, 0.22, '1.0 km x 0.22 dB/km = 0.22 dB');
  assert.strictEqual(r.rxPowerDbm, 3.78, '4 dBm - 0.22 dB = 3.78 dBm at the receiver');
  assert.strictEqual(r.verdict, 'fail', '3.78 dBm is 12.78 dB above a -9 dBm overload point');
  assert.ok(r.attenuator && r.attenuator.padDb === 16, 'the pad is 7 - (-9) = 16 dB: ' + JSON.stringify(r.attenuator));
  assert.ok(r.reasons.some(function (why) { return why.indexOf('overload') !== -1; }),
    'the refusal names the overload: ' + r.reasons.join(' | '));
  // And the class is not what failed: a 0.22 dB ODN is 30.78 dB inside the 31 dB N2 budget.
  assert.strictEqual(r.classHeadroomDb, 30.78, '31 dB class - 0.22 dB ODN = 30.78 dB left');
});

done();
