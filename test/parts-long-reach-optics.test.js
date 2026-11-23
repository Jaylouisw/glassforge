'use strict';
// The reach ladder had two holes: nothing at 10 Gb/s past 40 km, and nothing at 1 Gb/s between 10 and
// 80 km. Both are filled by vendor SKUs whose figures a buyer can re-check, not by another generic row:
// 10GBASE-ZR and 1000BASE-EX are vendor classes, so citing IEEE 802.3 for either would be a citation
// that does not contain the number. This suite keeps the figures tied to the datasheet and proves the
// two verdicts these parts are easy to get wrong - reach at 80 km, and OVERLOAD on a short EX span.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

const ZR = { model: 'sfp-plus-10g-zr-80km' };
const EX = { model: 'sfp-1g-ex-40km' };

test('the two long-reach optics carry their datasheet figures, not a class table', function () {
  const zr = registry.get('transceiver', 'sfp-plus-10g-zr-80km');
  assert.strictEqual(zr.vendor, 'cisco');
  assert.strictEqual(zr.speedMbps, 10000);
  assert.strictEqual(zr.wavelengthNm, 1550);
  assert.strictEqual(zr.reachM, 80000);
  // Cisco 10GBASE SFP+ data sheet, Table 4: launch 0..+4.0, overload -7.0, sensitivity -24.0 (no FEC).
  assert.strictEqual(zr.txPowerDbmMin, 0);
  assert.strictEqual(zr.txPowerDbmMax, 4);
  assert.strictEqual(zr.rxOverloadDbm, -7);
  assert.strictEqual(zr.rxSensitivityDbm, -24);
  assert.ok(/^https:\/\//.test(zr.sourceUrl), zr.sourceUrl);

  const ex = registry.get('transceiver', 'sfp-1g-ex-40km');
  assert.strictEqual(ex.vendor, 'cisco');
  assert.strictEqual(ex.speedMbps, 1000);
  assert.strictEqual(ex.wavelengthNm, 1310);
  assert.strictEqual(ex.reachM, 40000);
  // Cisco SFP/SFP+ installation notes: launch -1..+3, overload +1.0, sensitivity -22.0.
  assert.strictEqual(ex.txPowerDbmMin, -1);
  assert.strictEqual(ex.txPowerDbmMax, 3);
  assert.strictEqual(ex.rxOverloadDbm, 1);
  assert.strictEqual(ex.rxSensitivityDbm, -22);

  // Neither class exists in IEEE 802.3, and the note has to say so or the next reader will "correct"
  // the citation to a standard that does not publish these numbers.
  assert.ok(zr.notes.indexOf('NOT an IEEE 802.3 class') !== -1, zr.notes);
  assert.ok(ex.notes.indexOf('NOT an IEEE 802.3 class') !== -1, ex.notes);
});

test('10GBASE-ZR closes 70 km and is refused at 82 km on reach, not on loss', function () {
  const at70 = budget.pointToPoint({ headEnd: ZR, cpe: ZR,
    spans: [{ cable: 'g652d-loose-12', lengthM: 70000 }], splices: 5, connectors: 2 }, registry);
  // 70 km x 0.21 dB/km = 14.7 dB, 5 splices x 0.1 = 0.5, 2 connectors x 0.3 = 0.6 -> ODN 15.8 dB
  close(at70.odnLossDb, 15.8, 0.001, 'ODN loss at 70 km');
  // launch 0 dBm at 1550 nm: rx -15.8 dBm against -24 dBm sensitivity -> 8.2 dB headroom
  close(at70.rxPowerDbm, -15.8, 0.001, 'receive power');
  close(at70.headroomDb, 8.2, 0.001, 'headroom');
  // the pair's own budget: 0 - (-24) = 24 dB
  close(at70.budgetDb, 24, 0.001, 'link budget');
  assert.strictEqual(at70.verdict, 'ok');

  const at82 = budget.pointToPoint({ headEnd: ZR, cpe: ZR,
    spans: [{ cable: 'g652d-loose-12', lengthM: 82000 }], splices: 5, connectors: 2 }, registry);
  // 82 km x 0.21 = 17.22 + 0.5 + 0.6 = 18.32 dB -> 5.68 dB of headroom, still audible...
  close(at82.headroomDb, 5.68, 0.001, 'headroom at 82 km');
  // ...and refused only because 82 km is past the optic's reach.
  assert.strictEqual(at82.verdict, 'fail');
  assert.strictEqual(at82.reasons.length, 1, at82.reasons.join(' | '));
  assert.ok(at82.reasons[0].indexOf('optic reaches 80000 m') !== -1, at82.reasons[0]);
});

test('1000BASE-EX closes 35 km and is refused at 45 km on reach', function () {
  const at35 = budget.pointToPoint({ headEnd: EX, cpe: EX,
    spans: [{ cable: 'g652d-loose-12', lengthM: 35000 }], splices: 3, connectors: 2 }, registry);
  // 35 km x 0.35 dB/km = 12.25, 3 splices = 0.3, 2 connectors = 0.6 -> 13.15 dB
  close(at35.odnLossDb, 13.15, 0.001, 'ODN loss at 35 km');
  // launch floor -1 dBm -> -14.15 dBm against -22 dBm -> 7.85 dB headroom; budget -1 - (-22) = 21 dB
  close(at35.headroomDb, 7.85, 0.001, 'headroom');
  close(at35.budgetDb, 21, 0.001, 'link budget');
  assert.strictEqual(at35.verdict, 'ok');

  const at45 = budget.pointToPoint({ headEnd: EX, cpe: EX,
    spans: [{ cable: 'g652d-loose-12', lengthM: 45000 }], splices: 3, connectors: 2 }, registry);
  assert.ok(at45.reasons.some(function (r) { return r.indexOf('optic reaches 40000 m') !== -1; }), at45.reasons.join(' | '));
});

test('a short EX span on a hot transmitter fails on overload - an attenuator, not more reach', function () {
  const short = budget.pointToPoint({ headEnd: EX, cpe: EX, txDbm: 3,
    spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }], splices: 0, connectors: 2 }, registry);
  // 1.0 km x 0.35 = 0.35 dB, 2 connectors = 0.6 -> 0.95 dB; launch 3 dBm -> +2.05 dBm received
  close(short.rxPowerDbm, 2.05, 0.001, 'receive power at maximum launch');
  // 2.05 dBm is above the +1 dBm overload, while headroom against sensitivity is 24.05 dB: the link is
  // too loud, not too weak, and Cisco's own note calls for a 5 dB inline attenuator here.
  assert.strictEqual(short.verdict, 'fail');
  assert.ok(short.reasons.some(function (r) { return r.indexOf('above its overload point 1 dBm') !== -1; }), short.reasons.join(' | '));
  assert.ok(short.reasons.length === 1, 'overload is the only reason: ' + short.reasons.join(' | '));
});

test('the two parts are on different rates, so they cannot form a link with each other', function () {
  let message = null;
  try {
    budget.pointToPoint({ headEnd: ZR, cpe: EX, spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }] }, registry);
  } catch (err) { message = err.message; }
  assert.ok(message && message.indexOf('different rates') !== -1, String(message));
});

done();
