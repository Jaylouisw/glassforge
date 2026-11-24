'use strict';
// The catalogue had no coherent optic at all: every DC-to-DC leg in it was a lane-bonded client
// (400GBASE-FR4/LR4, 100GBASE-ZR4), and the module the metro actually buys for a router-to-router
// span is a 400ZR DCO. This suite pins the datasheet figures and the one reading that matters: the
// 80 km the sheets declare is an AMPLIFIED reach, and the engine has no amplifier, so the row's own
// launch-minus-sensitivity budget runs out around 21 km and every longer span must fail out loud.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;
const ZR = { model: 'qsfp-dd-400g-zr-80km' };

function span(lengthM, connectors) {
  return budget.pointToPoint({
    headEnd: ZR,
    cpe: ZR,
    spans: [{ cable: 'g652d-loose-12', lengthM: lengthM }],
    splices: 0,
    connectors: connectors || 0
  }, registry);
}

test('the coherent row carries its datasheet figures and says where they came from', function () {
  const zr = registry.get('transceiver', 'qsfp-dd-400g-zr-80km');
  assert.strictEqual(zr.vendor, 'generic');
  assert.strictEqual(zr.speedMbps, 400000);
  // 1550 nm, not 1310: this is one C-band coherent carrier, and 1550 is the window the cables publish.
  assert.strictEqual(zr.wavelengthNm, 1550);
  assert.strictEqual(zr.reachM, 80000);
  // FS QSFPDD-ZR-400G: launch -10..-6 dBm at the connector, unamplified input sensitivity -20 dBm,
  // 400G-mode input range -12..0 dBm. Cisco QDD-400G-ZR-S is the corroboration, not the source.
  assert.strictEqual(zr.txPowerDbmMin, -10);
  assert.strictEqual(zr.txPowerDbmMax, -6);
  assert.strictEqual(zr.rxSensitivityDbm, -20);
  assert.strictEqual(zr.rxOverloadDbm, 0);
  assert.ok(/^https:\/\//.test(zr.sourceUrl), zr.sourceUrl);
  assert.ok(zr.notes.indexOf('OIF 400ZR') !== -1, zr.notes);
  assert.ok(zr.notes.indexOf('no amplifier') !== -1 || zr.notes.indexOf('does not model') !== -1, zr.notes);
  assert.ok(zr.notes.indexOf('replace the row with the QSFP-DD actually purchased') !== -1, zr.notes);
});

test('the row can afford 10.0 dB, and the default margin ends it near 21 km', function () {
  // 20 km x 0.21 = 4.20 dB of fibre + 2 x 0.30 matings = 4.80 dB; -10.0 - 4.80 = -14.80 dBm
  const at20 = span(20000, 2);
  close(at20.budgetDb, 10, 0.001, 'launch floor minus sensitivity');
  close(at20.odnLossDb, 4.8, 0.001, 'ODN loss at 20 km');
  close(at20.rxPowerDbm, -14.8, 0.001, 'receive power at 20 km');
  close(at20.headroomDb, 5.2, 0.001, 'headroom at 20 km');
  assert.strictEqual(at20.verdict, 'ok');
  assert.strictEqual(at20.attenuator, null, 'a coherent span this short still needs no pad');

  // 20.95 km x 0.21 = 4.3995 + 0.60 = 4.9995 dB -> 5.0005 dB of headroom, the last length that reads ok
  close(span(20950, 2).headroomDb, 5, 0.001, 'headroom at 20.95 km');
  assert.strictEqual(span(20950, 2).verdict, 'ok');
  // 21 km x 0.21 = 4.41 + 0.60 = 5.01 dB -> 4.99 dB: below margin + 2, so marginal, not ok
  close(span(21000, 2).odnLossDb, 5.01, 0.001, 'ODN loss at 21 km');
  assert.strictEqual(span(21000, 2).verdict, 'marginal');

  // bare fibre (no matings) reaches further: 23.81 km x 0.21 = 5.0001 dB, the last ok length
  assert.strictEqual(span(23800, 0).verdict, 'ok');
  assert.strictEqual(span(23900, 0).verdict, 'marginal');
});

test('the declared 80 km fails on loss, and reach is not the verdict that refused it', function () {
  // 80 km x 0.21 = 16.80 dB of fibre + 0.60 = 17.40 dB; -10.0 - 17.4 = -27.4 dBm against -20 dBm
  const at80 = span(80000, 2);
  close(at80.odnLossDb, 17.4, 0.001, 'ODN loss at 80 km');
  close(at80.rxPowerDbm, -27.4, 0.001, 'receive power at 80 km');
  close(at80.headroomDb, -7.4, 0.001, 'headroom at 80 km');
  assert.strictEqual(at80.verdict, 'fail');
  // Both verdicts fire: short of the margin, and past the 10 dB the pair can afford.
  const said = at80.reasons.join(' ');
  assert.ok(said.indexOf('below the 3 dB design margin') !== -1, said);
  assert.ok(said.indexOf('exceeds the 10 dB this optic pair can afford') !== -1, said);
  // The route is exactly the declared reach, so the distance check must stay quiet.
  assert.ok(said.indexOf('reaches') === -1, said);
});

test('a patched pair reads -10.6 dBm and the row proposes no pad', function () {
  // No spans, two matings: 0.60 dB; -10.0 - 0.60 = -10.60 dBm, ten dB under the 0 dBm maximum.
  const backToBack = budget.pointToPoint({ headEnd: ZR, cpe: ZR, splices: 0, connectors: 2 }, registry);
  close(backToBack.rxPowerDbm, -10.6, 0.001, 'receive power, back to back');
  assert.strictEqual(backToBack.attenuator, null);
  assert.strictEqual(backToBack.verdict, 'ok');
});

done();
