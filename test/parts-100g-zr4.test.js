'use strict';
// The 100G rung stopped at 40 km (100GBASE-ER4). A site-to-site leg over imported duct geometry is
// where that bites: 40 km is one regeneration site away from being a link, and 80 km is the module the
// market sells for it. 100GBASE-ZR4 is not an IEEE 802.3 class, so - as with 1000BASE-ZX - the figures
// come from a vendor sheet and the note has to say so. This suite pins the datasheet numbers and the
// three verdicts this optic is easy to get wrong: the margin at its own 80 km, the pad a short span
// needs, and the mixed pair the engine cannot tell from ER4.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;
const ZR4 = { model: 'qsfp28-100g-zr4-80km' };
const ER4 = { model: 'qsfp28-100g-er4-40km' };

test('the ZR4 row carries its datasheet figures and says where they came from', function () {
  const zr = registry.get('transceiver', 'qsfp28-100g-zr4-80km');
  assert.strictEqual(zr.vendor, 'generic');
  assert.strictEqual(zr.speedMbps, 100000);
  assert.strictEqual(zr.wavelengthNm, 1310);
  assert.strictEqual(zr.reachM, 80000);
  // ROBOfiber QSFP-10080-ZR4 optical characteristics, per lane: launch +2.0..+6.5,
  // receive -28..-7, sensitivity -28 dBm at BER 5e-5 with FEC.
  assert.strictEqual(zr.txPowerDbmMin, 2);
  assert.strictEqual(zr.txPowerDbmMax, 6.5);
  assert.strictEqual(zr.rxSensitivityDbm, -28);
  assert.strictEqual(zr.rxOverloadDbm, -7);
  assert.ok(/^https:\/\//.test(zr.sourceUrl), zr.sourceUrl);
  assert.ok(zr.notes.indexOf('NOT an IEEE 802.3 class') !== -1, zr.notes);
  assert.ok(zr.notes.indexOf('WITH FEC') !== -1, zr.notes);
  assert.ok(zr.notes.indexOf('replace the row with the module actually purchased') !== -1, zr.notes);
});

test('80 km is inside the class and outside the default margin - the loss binds, not reach', function () {
  const at60 = budget.pointToPoint({ headEnd: ZR4, cpe: ZR4,
    spans: [{ cable: 'g652d-loose-12', lengthM: 60000 }], splices: 0, connectors: 0 }, registry);
  // 60 km x 0.35 dB/km = 21.0 dB; launch floor +2.0 -> -19.0 dBm against -28 dBm = 9.0 dB headroom
  close(at60.odnLossDb, 21, 0.001, 'ODN loss at 60 km');
  close(at60.headroomDb, 9, 0.001, 'headroom at 60 km');
  // the pair's own budget: 2.0 - (-28) = 30 dB
  close(at60.budgetDb, 30, 0.001, 'link budget');
  assert.strictEqual(at60.verdict, 'ok');

  const at80 = budget.pointToPoint({ headEnd: ZR4, cpe: ZR4,
    spans: [{ cable: 'g652d-loose-12', lengthM: 80000 }], splices: 0, connectors: 0 }, registry);
  // 80 km x 0.35 = 28.0 dB of the 30 -> 2.0 dB of headroom, under the 3 dB default margin
  close(at80.odnLossDb, 28, 0.001, 'ODN loss at 80 km');
  close(at80.headroomDb, 2, 0.001, 'headroom at 80 km');
  assert.strictEqual(at80.verdict, 'fail');
  // and the reach verdict is not the one that refused it
  assert.ok(at80.reasons.join(' ').indexOf('reaches') === -1, at80.reasons);

  const at71 = budget.pointToPoint({ headEnd: ZR4, cpe: ZR4,
    spans: [{ cable: 'g652d-loose-12', lengthM: 71000 }], splices: 0, connectors: 0 }, registry);
  // 71 km x 0.35 = 24.85 -> 5.15 dB headroom: the last bare span that reads ok (ok needs margin + 2)
  close(at71.headroomDb, 5.15, 0.001, 'headroom at 71 km');
  assert.strictEqual(at71.verdict, 'ok');
});

test('a short ZR4 span is refused on overload and the verdict names the pad', function () {
  const at10 = budget.pointToPoint({ headEnd: ZR4, cpe: ZR4,
    spans: [{ cable: 'g652d-loose-12', lengthM: 10000 }], splices: 0, connectors: 2 }, registry);
  // 10 km x 0.35 = 3.5 + 2 x 0.3 connector = 4.1 dB; 2.0 - 4.1 = -2.1 dBm against a -7 dBm maximum
  close(at10.odnLossDb, 4.1, 0.001, 'ODN loss at 10 km');
  close(at10.rxPowerDbm, -2.1, 0.001, 'receive power at 10 km');
  assert.strictEqual(at10.verdict, 'fail');
  assert.ok(at10.attenuator, 'a pad is required');
  // 6.5 dBm ceiling - (-7 dBm maximum) - 4.1 dB of span = 9.4 dB to shed, rounded up to a 10 dB pad
  close(at10.attenuator.overDb, 9.4, 0.001, 'power above overload');
  assert.strictEqual(at10.attenuator.padDb, 10);

  // the launch floor is 9 dB above the receive maximum, so 9 / 0.35 = 25.7 km is the last loud length
  const at25 = budget.pointToPoint({ headEnd: ZR4, cpe: ZR4,
    spans: [{ cable: 'g652d-loose-12', lengthM: 25000 }], splices: 0, connectors: 0 }, registry);
  assert.ok(at25.attenuator, '25 km is still too loud at +2.0 dBm');
  const at26 = budget.pointToPoint({ headEnd: ZR4, cpe: ZR4,
    spans: [{ cable: 'g652d-loose-12', lengthM: 26000 }], splices: 0, connectors: 0 }, registry);
  // 26 km x 0.35 = 9.1 dB -> -7.1 dBm, just under the -7 dBm maximum
  close(at26.odnLossDb, 9.1, 0.001, 'ODN loss at 26 km');
  assert.strictEqual(at26.attenuator, null);
  assert.strictEqual(at26.verdict, 'ok');
});

test('ZR4 and ER4 share 1310 nm and 100000 Mb/s, so a mixed pair is accepted and held to 40 km', function () {
  // The engine budgets one wavelength; both rows sit at 1310 nm, so it cannot see that one is a 4-lane
  // LAN-WDM ZR4 and the other a 4-lane ER4. Documented limitation, not a claim that the pair works.
  const at35 = budget.pointToPoint({ headEnd: ZR4, cpe: ER4,
    spans: [{ cable: 'g652d-loose-12', lengthM: 35000 }], splices: 0, connectors: 2 }, registry);
  assert.strictEqual(at35.reachM, 40000);
  // budget read across the pair: ZR4 launch floor +2.0 - ER4 sensitivity -20.9 = 22.9 dB
  close(at35.budgetDb, 22.9, 0.001, 'mixed-pair budget');
  assert.strictEqual(at35.verdict, 'ok');

  const at45 = budget.pointToPoint({ headEnd: ZR4, cpe: ER4,
    spans: [{ cable: 'g652d-loose-12', lengthM: 45000 }], splices: 0, connectors: 2 }, registry);
  assert.strictEqual(at45.verdict, 'fail');
  assert.ok(at45.reasons.join(' ').indexOf('reaches 40000') !== -1, at45.reasons);
});

done();
