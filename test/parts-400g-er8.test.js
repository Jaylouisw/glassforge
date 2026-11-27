'use strict';
// The 400G ladder had 10 km (400GBASE-LR4) and 80 km (400GBASE-ZR) and nothing between, so a 30 km
// DC-to-DC pair was quoted at either end of a 70 km jump. This suite pins the 40 km rung to the FS
// datasheet numbers and to the three verdicts that row is easy to get wrong: a bare 40 km run is
// marginal rather than ok, the receive window average minimum is what reproduces the 18 dB the sheet
// declares for 40 km (its OMAouter sensitivity line would under-read by 2.5 dB), and the +5.6 dBm launch
// ceiling makes a short run an overload failure that needs a 10 dB pad - the inverse of the LR4 row.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;
const ER8 = { model: 'qsfp-dd-400g-er8-40km' };

test("the ER8 row carries the FS average-power window and reconciles to the sheet's 18 dB", function () {
  const er8 = registry.get('transceiver', 'qsfp-dd-400g-er8-40km');
  assert.strictEqual(er8.vendor, 'fs');
  assert.strictEqual(er8.speedMbps, 400000);
  assert.strictEqual(er8.wavelengthNm, 1310);
  assert.strictEqual(er8.reachM, 40000);
  // FS QSFPDD-ER8-400G, per lane: average launch -0.6..+5.6 dBm; average receive -18.6..-4.4 dBm.
  assert.strictEqual(er8.txPowerDbmMin, -0.6);
  assert.strictEqual(er8.txPowerDbmMax, 5.6);
  assert.strictEqual(er8.rxSensitivityDbm, -18.6);
  assert.strictEqual(er8.rxOverloadDbm, -4.4);
  assert.ok(/^https:\/\//.test(er8.sourceUrl), er8.sourceUrl);
  assert.ok(er8.notes.indexOf('18.0 dB') !== -1, er8.notes);
  assert.ok(er8.notes.indexOf('replace with the QSFP-DD actually bought') !== -1, er8.notes);

  // The sheet also prints receiver sensitivity as OMAouter max(-16.1, SECQ-17.5). Storing that would
  // subtract an OMA figure from an average launch and read 15.5 dB - 2.5 dB under the 18 dB the sheet
  // declares for the same 40 km, so the row must keep the average window.
  assert.notStrictEqual(er8.rxSensitivityDbm, -16.1, 'the OMAouter line is not the average receiver minimum');
});

test('a bare 40 km run is marginal; 37.1 km clears the margin and 37.2 km does not', function () {
  const at40 = budget.pointToPoint({ headEnd: ER8, cpe: ER8,
    spans: [{ cable: 'g652d-loose-12', lengthM: 40000 }], splices: 0, connectors: 0 }, registry);
  // 40 km x 0.35 dB/km = 14.0 dB; -0.6 - (-18.6) = 18.0 dB -> 4.0 dB of headroom (ok needs 5.0).
  close(at40.odnLossDb, 14, 0.001, 'ODN loss at 40 km');
  close(at40.budgetDb, 18, 0.001, 'link budget is the launch floor minus sensitivity');
  close(at40.headroomDb, 4, 0.001, 'headroom at 40 km');
  assert.strictEqual(at40.verdict, 'marginal');

  // (18.0 - 5.0) / 0.35 = 37.14 km is the last length inside the ok band.
  const at371 = budget.pointToPoint({ headEnd: ER8, cpe: ER8,
    spans: [{ cable: 'g652d-loose-12', lengthM: 37100 }], splices: 0, connectors: 0 }, registry);
  close(at371.headroomDb, 5.02, 0.001, 'headroom at 37.1 km');
  assert.strictEqual(at371.verdict, 'ok');

  const at372 = budget.pointToPoint({ headEnd: ER8, cpe: ER8,
    spans: [{ cable: 'g652d-loose-12', lengthM: 37200 }], splices: 0, connectors: 0 }, registry);
  close(at372.headroomDb, 4.98, 0.001, 'headroom at 37.2 km');
  assert.strictEqual(at372.verdict, 'marginal');
});

test('two patch panels on the 40 km run cost 0.6 dB and stay marginal, not fail', function () {
  const patched = budget.pointToPoint({ headEnd: ER8, cpe: ER8,
    spans: [{ cable: 'g652d-loose-12', lengthM: 40000 }], splices: 0, connectors: 2 }, registry);
  // 14.0 + 2 x 0.3 (sc-apc) = 14.6 dB -> 3.4 dB, above the 3 dB margin and below the ok band.
  close(patched.odnLossDb, 14.6, 0.001, 'ODN loss with two patch panels');
  close(patched.headroomDb, 3.4, 0.001, 'headroom with two patch panels');
  assert.strictEqual(patched.verdict, 'marginal');
  assert.strictEqual(patched.reasons.length, 0, patched.reasons);
});

test('a short run is an overload failure that needs a 10 dB pad', function () {
  const short = budget.pointToPoint({ headEnd: ER8, cpe: ER8,
    spans: [{ cable: 'g652d-loose-12', lengthM: 100 }], splices: 0, connectors: 0 }, registry);
  // 0.1 km x 0.35 = 0.035 dB; -0.6 - 0.035 = -0.63 dBm against a -4.4 dBm overload point.
  close(short.rxPowerDbm, -0.63, 0.001, 'receive power at 100 m');
  assert.strictEqual(short.verdict, 'fail');
  assert.ok(short.attenuator, 'a floor-launch overload reports the pad in attenuator');
  // 5.6 - (-4.4) = 10.0 dB of path loss before the payload at the top of the window.
  assert.strictEqual(short.attenuator.padDb, 10);
  assert.strictEqual(short.attenuator.fits, true);
  assert.ok(short.reasons.join(' ').indexOf('overload point') !== -1, short.reasons);
});

test('near the boundary the verdict turns on the top of the launch window', function () {
  // 26.9 km + 0.6 dB of patch panels = 10.015 dB, just past the 10.0 dB the ceiling needs.
  const clear = budget.pointToPoint({ headEnd: ER8, cpe: ER8,
    spans: [{ cable: 'g652d-loose-12', lengthM: 26900 }], splices: 0, connectors: 2 }, registry);
  close(clear.odnLossDb, 10.015, 0.001, 'ODN loss at 26.9 km');
  assert.strictEqual(clear.attenuator, null);
  assert.strictEqual(clear.launchWindowPad, null, 'no pad at the launch ceiling either');
  assert.strictEqual(clear.verdict, 'ok');

  // 26.7 km is 9.945 dB: fine at the -0.6 dBm floor, 0.05 dB loud at the +5.6 dBm ceiling.
  const tight = budget.pointToPoint({ headEnd: ER8, cpe: ER8,
    spans: [{ cable: 'g652d-loose-12', lengthM: 26700 }], splices: 0, connectors: 2 }, registry);
  close(tight.odnLossDb, 9.945, 0.001, 'ODN loss at 26.7 km');
  assert.strictEqual(tight.attenuator, null);
  assert.ok(tight.launchWindowPad, 'the ceiling launch is too loud, so the design needs a pad to hold there');
  assert.strictEqual(tight.launchWindowPad.padDb, 1);
  assert.ok(tight.warnings.join(' ').indexOf('1 dB inline pad') !== -1, tight.warnings);
});

done();
