'use strict';
// The 800G family stopped at 2 km: osfp-800g-fr4-2km was the only 800G row, and no 500 m rung
// existed, so an in-building 800G link had to be ordered on a 2 km optic. The FR4 row also said a
// parallel-lane 800G row could not exist "until the model has a fibre-count contract" - but
// link.design has carried `fibres` per leg since the DR4 row needed eight strands, so the row could.
//
// Figures: FS 800GBASE-DR8 OSFP datasheet (per lane, average) plus Asterfusion OT-800G-OSFP-DR8,
// AO 80-21-1629A001 and Gigalight GOS-SI801DR8CA, which print the same four numbers.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;
const link = engine.link;

const MODEL = 'osfp-800g-dr8-500m';

function p2p(lengthM, marginDb) {
  return budget.pointToPoint({
    headEnd: { model: MODEL },
    cpe: { model: MODEL },
    spans: lengthM === 0 ? [] : [{ cable: 'g652d-loose-24', lengthM: lengthM }],
    connectors: { model: 'mpo-12-apc', count: 2 },
    marginDb: marginDb === undefined ? 3 : marginDb
  }, registry);
}

test('the 800GBASE-DR8 row publishes the per-lane averages its sheets print', function () {
  const dr8 = registry.get('transceiver', MODEL);
  assert.strictEqual(dr8.speedMbps, 800000);
  assert.strictEqual(dr8.wavelengthNm, 1310, 'one wavelength window the cables publish attenuation for');
  assert.strictEqual(dr8.reachM, 500);
  assert.strictEqual(dr8.txPowerDbmMin, -2.9, 'average launch power MIN, each lane');
  assert.strictEqual(dr8.txPowerDbmMax, 4.0, 'average launch power MAX, each lane');
  assert.strictEqual(dr8.rxSensitivityDbm, -5.9, 'average receive power MIN, each lane - not the OMA -3.9');
  assert.strictEqual(dr8.rxOverloadDbm, 4.0, 'average receive power MAX, each lane');
  assert.strictEqual(dr8.polish, 'apc', 'MPO-16/APC (or twin MPO-12/APC on two vendors)');
  assert.ok(/^https:\/\//.test(dr8.sourceUrl), dr8.sourceUrl);
});

test('DR8 is the 100GBASE-DR lane class, and the budget does not grow with lane count', function () {
  const dr8 = registry.get('transceiver', MODEL);
  const dr = registry.get('transceiver', 'qsfp28-100g-dr-500m');
  const dr4 = registry.get('transceiver', 'qsfp-dd-400g-dr4-500m');
  // -2.9 - (-5.9) = 3.0 dB, the same subtraction on all three rows because it is the same lane.
  // Rounded because binary floats give 3.0000000000000004 for it; the budget module rounds too.
  function classDb(optic) {
    return Math.round((optic.txPowerDbmMin - optic.rxSensitivityDbm) * 100) / 100;
  }
  assert.strictEqual(classDb(dr8), 3.0);
  assert.strictEqual(classDb(dr), 3.0);
  assert.strictEqual(classDb(dr4), 3.0);
  assert.strictEqual(p2p(500).budgetDb, 3);
});

test('500 m on the DR8 row: 0.575 dB of ODN, 2.43 dB of headroom, fail at the default margin', function () {
  // 500 m x 0.35 dB/km = 0.175 dB of fibre, plus 2 MPO matings at 0.2 dB = 0.4 dB -> 0.575 dB ODN.
  // Headroom = 3.0 dB class - 0.575 = 2.425 -> 2.43 rounded, below the 3 dB margin -> fail.
  const at500 = p2p(500);
  assert.strictEqual(at500.odnLossDb, 0.575);
  assert.strictEqual(at500.headroomDb, 2.43);
  assert.strictEqual(at500.verdict, 'fail');
  // ok needs margin + 2, so a 2.43 dB class cannot read ok at any margin above 0.43 dB: at 2.4 it is
  // marginal, never ok. Lowering the margin by 0.6 dB does not buy a green link.
  assert.strictEqual(p2p(500, 2.4).verdict, 'marginal');
  // 501 m is past the optic's declared reach, and the reason names the distance, not the loss.
  const at501 = p2p(501);
  assert.strictEqual(at501.verdict, 'fail');
  assert.ok(at501.reasons.some(function (r) { return /reaches 500 m/.test(r); }), at501.reasons.join(' | '));
});

test('a back-to-back DR8 pair needs no pad: launch ceiling equals the receiver maximum', function () {
  // 0 m of fibre, two matings: ODN 0.4 dB, headroom 3.0 - 0.4 = 2.6 dB. Launch max +4.0 equals the
  // receive max +4.0, so 4.0 - 0.4 = 3.6 dBm is still under the overload point - attenuator null.
  const patch = p2p(0);
  assert.strictEqual(patch.odnLossDb, 0.4);
  assert.strictEqual(patch.headroomDb, 2.6);
  assert.strictEqual(patch.attenuator, null);
});

test('fibres: 16 is what puts 16 strands on the leg - the optic does not state its own strand count', function () {
  // link.design's `fibres` defaults to 2; cableForFibres refuses a cable that cannot carry the count.
  // On the default ladder the smallest rung carrying 16 is g652d-loose-24 (12 < 16 <= 24).
  const sites = { a: { lat: 51.5, lon: -0.1 }, b: { lat: 51.5045, lon: -0.1 } };
  const sixteen = link.design({ sites: sites, optics: { a: MODEL, b: MODEL }, fibres: 16 }, registry);
  assert.strictEqual(sixteen.legs[0].cable, 'g652d-loose-24');
  const two = link.design({ sites: sites, optics: { a: MODEL, b: MODEL } }, registry);
  assert.notStrictEqual(two.legs[0].cable, 'g652d-loose-24', 'the default leg is a two-strand leg');
  // routeFactor 1.2 turns that 500.3 m straight-line pair into a 600.45 m leg, past the 500 m reach,
  // so the design is refused on reach even though the loss budget would allow the distance.
  assert.ok(Math.abs(sixteen.legs[0].lengthM - 600.45) < 0.01, String(sixteen.legs[0].lengthM));
  assert.strictEqual(sixteen.legs[0].budget.verdict, 'fail');
});

done();
