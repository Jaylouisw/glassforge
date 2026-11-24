'use strict';
// The 1000BASE-ZX row carried -24 dBm as its sensitivity, and nothing it cited printed that figure:
// the Cisco document behind the row gives -23 dBm, and -24 is a third-party "ZX-compatible" claim. A
// guessed 1 dB is the worst kind of catalogue error - it is invisible in the BOM, it makes every long
// 1G link look 1 dB healthier than it is, and only a test that drives the budget can tell the two rows
// apart. This suite pins the row to the datasheet table, so the next person to "round it up" has to
// disagree with a measured number.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

const ZX = { model: 'sfp-1g-zx-80km' };

test('the 1000BASE-ZX row carries the vendor figure, not a third-party -24 dBm', function () {
  const zx = registry.get('transceiver', 'sfp-1g-zx-80km');
  // Cisco SFP and SFP+ installation notes, Table 5: GLC-ZX-SM/SMD and SFP-GE-Z.
  assert.strictEqual(zx.speedMbps, 1000);
  assert.strictEqual(zx.wavelengthNm, 1550);
  assert.strictEqual(zx.txPowerDbmMin, 0);
  assert.strictEqual(zx.txPowerDbmMax, 5);
  assert.strictEqual(zx.rxOverloadDbm, -3);
  assert.strictEqual(zx.rxSensitivityDbm, -23, '-24 dBm is not in the document this row cites');
  assert.ok(/^https:\/\//.test(zx.sourceUrl), zx.sourceUrl);
  // A vendor class with a vendor figure: the note has to keep saying so, or the citation gets
  // "corrected" to an IEEE 802.3 table that does not contain 1000BASE-ZX at all.
  assert.ok(zx.notes.indexOf('NOT an IEEE 802.3 class') !== -1, zx.notes);
  assert.ok(zx.notes.indexOf('-24') !== -1, 'the notes name the figure this row used to carry: ' + zx.notes);
});

test('80 km of ZX reads 5.1 dB of headroom against a 23 dB pair budget', function () {
  const r = budget.pointToPoint({ headEnd: ZX, cpe: ZX,
    spans: [{ cable: 'g652d-loose-12', lengthM: 80000 }], splices: 5, connectors: 2 }, registry);
  // 80 km x 0.21 dB/km = 16.8, 5 splices x 0.1 = 0.5, 2 connector pairs x 0.3 = 0.6 -> 17.9 dB
  close(r.odnLossDb, 17.9, 0.001, 'ODN loss at 80 km');
  // launch floor 0 dBm -> -17.9 dBm received; -17.9 against -23 is 5.1 dB, not the 6.1 a -24 row reads
  close(r.rxPowerDbm, -17.9, 0.001, 'receive power');
  close(r.headroomDb, 5.1, 0.001, 'headroom against -23 dBm');
  // the pair's own budget: 0 - (-23) = 23 dB. The old row claimed 24.
  close(r.budgetDb, 23, 0.001, 'link budget');
  assert.strictEqual(r.verdict, 'ok');
});

test('a 120 km route is refused on the loss budget and the reach, not quietly passed', function () {
  const r = budget.pointToPoint({ headEnd: ZX, cpe: ZX,
    spans: [{ cable: 'g652d-loose-12', lengthM: 120000 }], splices: 5, connectors: 2 }, registry);
  // 120 km x 0.21 = 25.2 + 0.5 + 0.6 = 26.3 dB of ODN into a 23 dB pair
  close(r.odnLossDb, 26.3, 0.001, 'ODN loss at 120 km');
  close(r.headroomDb, -3.3, 0.001, 'headroom');
  assert.strictEqual(r.verdict, 'fail');
  assert.ok(r.reasons.some(function (x) { return x.indexOf('exceeds the 23 dB') !== -1; }), r.reasons.join(' | '));
  assert.ok(r.reasons.some(function (x) { return x.indexOf('optic reaches 80000 m') !== -1; }), r.reasons.join(' | '));
});

test('a short ZX span fails on overload, and the pad it needs is the 8 dB the vendor specifies', function () {
  const aKilometre = budget.pointToPoint({ headEnd: ZX, cpe: ZX, txDbm: 5,
    spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }], splices: 0, connectors: 2 }, registry);
  // 1.0 km x 0.21 = 0.21 dB, two connector pairs = 0.6 -> 0.81 dB; a +5 dBm launch arrives at 4.19 dBm
  close(aKilometre.rxPowerDbm, 4.19, 0.001, 'receive power at the launch ceiling');
  // 4.19 against a -3 dBm overload is 7.19 dB too loud: 8 dB is the smallest whole-dB pad, and that is
  // exactly the "minimum attenuation between TX and RX" Cisco prints for the GLC-ZX-SM.
  assert.strictEqual(aKilometre.verdict, 'fail');
  assert.strictEqual(aKilometre.attenuator.padDb, 8, 'Cisco: 8 dB minimum attenuation TX to RX');
  close(aKilometre.attenuator.overDb, 7.19, 0.001, 'how far above overload');
  assert.ok(aKilometre.reasons.every(function (x) { return x.indexOf('overload') !== -1; }),
    'overload is the only reason: ' + aKilometre.reasons.join(' | '));

  // The pad window is real to about 38 km, not 40: 8 dB / 0.21 dB/km. At 35 km the span has 7.95 dB of
  // loss, so a +5 dBm launch still lands 0.05 dB above -3 dBm and still needs 1 dB of pad.
  const at35 = budget.pointToPoint({ headEnd: ZX, cpe: ZX, txDbm: 5,
    spans: [{ cable: 'g652d-loose-12', lengthM: 35000 }], splices: 0, connectors: 2 }, registry);
  close(at35.rxPowerDbm, -2.95, 0.001, 'receive power at 35 km');
  assert.strictEqual(at35.verdict, 'fail');
  assert.strictEqual(at35.attenuator.padDb, 1, 'the last kilometre of the pad window');

  // And at 80 km with the launch ceiling the span is quiet again: no pad asked for.
  const at80 = budget.pointToPoint({ headEnd: ZX, cpe: ZX, txDbm: 5,
    spans: [{ cable: 'g652d-loose-12', lengthM: 80000 }], splices: 5, connectors: 2 }, registry);
  assert.strictEqual(at80.attenuator, null, 'no overload answer on a long run');
  assert.strictEqual(at80.verdict, 'ok');
});

done();
