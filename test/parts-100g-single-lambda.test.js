'use strict';
// 100G in this catalogue was 4-lane LAN-WDM only (LR4 / ER4 / ZR4), so every 100G budget carried a
// hand-wave: four wavelengths modelled as one, read at the top lane, worst lane quoted. IEEE 802.3cu
// defines the single-lambda pair (100GBASE-FR1 at 2 km, 100GBASE-LR1 at 10 km) and they cost nothing
// to model - one carrier at 1310 nm, a window the cables publish attenuation for. These assertions pin
// the clause figures and, more importantly, pin what the engine does with them: LR1 spends the same
// 6.3 dB channel insertion loss LR4 does, and FR1's 4.0 dB class leaves less spare than the default
// design margin, which is the fact a designer needs before specifying it.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const parts = require('../engine/parts');

const registry = parts.createRegistry();
const budget = engine.budget;
const LR1 = { model: 'qsfp28-100g-lr1-10km' };
const FR1 = { model: 'qsfp28-100g-fr1-2km' };

function link(headEnd, cpe, lengthM, connectors) {
  return budget.pointToPoint({
    headEnd: headEnd,
    cpe: cpe,
    spans: [{ cable: 'g652d-loose-12', lengthM: lengthM }],
    connectors: connectors === undefined ? 0 : connectors,
    splices: 0
  }, registry);
}

test('the LR1 row carries the launch and receive figures of 802.3cu clause 140', function () {
  // Clause 140: -1.9..+4.8 dBm average launch, -8.2..+4.8 dBm average receive, 1304.5-1317.5 nm,
  // 10 km, one 53.125 GBd PAM4 carrier. Ascent's 802.3cu D3.2 sheet prints the same four numbers.
  const lr1 = registry.get('transceiver', 'qsfp28-100g-lr1-10km');
  assert.strictEqual(lr1.speedMbps, 100000, 'LR1 is a 100G optic');
  assert.strictEqual(lr1.wavelengthNm, 1310, 'one carrier at 1310 nm');
  assert.strictEqual(lr1.reachM, 10000, 'LR1 reaches 10 km');
  assert.strictEqual(lr1.txPowerDbmMin, -1.9, 'average launch MIN is -1.9 dBm');
  assert.strictEqual(lr1.txPowerDbmMax, 4.8, 'average launch MAX is +4.8 dBm');
  assert.strictEqual(lr1.rxSensitivityDbm, -8.2, 'average receive MIN is -8.2 dBm');
  assert.strictEqual(lr1.rxOverloadDbm, 4.8, 'average receive MAX is +4.8 dBm');
  assert.ok(/^https:\/\//.test(lr1.sourceUrl), lr1.sourceUrl);
  assert.ok(lr1.notes.indexOf('replace the row with the module actually purchased') !== -1, lr1.notes);
  // The point of the row: 1310 nm is a wavelength every cable in this catalogue publishes.
  assert.strictEqual(budget.cableAttenuation(registry.get('cable', 'g652d-loose-12'), '1310'), 0.35);
});

test('the FR1 row carries its 2 km class figures and says FEC is part of the class', function () {
  const fr1 = registry.get('transceiver', 'qsfp28-100g-fr1-2km');
  assert.strictEqual(fr1.speedMbps, 100000);
  assert.strictEqual(fr1.wavelengthNm, 1310);
  assert.strictEqual(fr1.reachM, 2000, 'FR1 is the 2 km rung');
  assert.strictEqual(fr1.txPowerDbmMin, -2.4, 'average launch MIN is -2.4 dBm');
  assert.strictEqual(fr1.txPowerDbmMax, 4, 'average launch MAX is +4.0 dBm');
  assert.strictEqual(fr1.rxSensitivityDbm, -6.4, 'average receive MIN is -6.4 dBm');
  assert.strictEqual(fr1.rxOverloadDbm, 4.5, 'average receive MAX is +4.5 dBm');
  assert.ok(fr1.notes.indexOf('FEC') !== -1, 'the row must say FEC is required: ' + fr1.notes);
  assert.ok(fr1.notes.indexOf('replace the row with the module actually purchased') !== -1, fr1.notes);
});

test('LR1 spends the 6.3 dB channel insertion loss, not the 10.6 dB power budget', function () {
  // 802.3cu prints a 10.6 dB power budget for the class, but it is 6.3 dB of channel plus the 4.3 dB
  // a worst-case PAM4 eye costs (TDECQ). The engine compares average launch with average receive,
  // so -1.9 - (-8.2) = 6.3 is the whole figure it may spend - the same arithmetic as 25GBASE-LR.
  const at10 = link(LR1, LR1, 10000);
  assert.strictEqual(at10.budgetDb, 6.3, 'launch floor -1.9 minus sensitivity -8.2');
  // 10 km x 0.35 dB/km = 3.5 dB of fibre -> -5.4 dBm received, 2.8 dB above -8.2
  close(at10.odnLossDb, 3.5, 0.001, 'ODN loss at 10 km');
  close(at10.rxPowerDbm, -5.4, 0.001, 'receive power at 10 km');
  close(at10.headroomDb, 2.8, 0.001, 'headroom at 10 km');
  // 10.6 - 6.3 = 4.3: the budget the clause prints and the budget the engine spends are not the same
  close(10.6 - at10.budgetDb, 4.3, 0.001, 'TDECQ allowance inside the printed power budget');
  assert.strictEqual(at10.verdict, 'fail', '2.8 dB of reserve is under the 3 dB default margin');
  // ... and it is the margin that refused it, not the reach
  assert.ok(at10.reasons.join(' ').indexOf('design margin') !== -1, at10.reasons);
  assert.ok(at10.reasons.join(' ').indexOf('reaches') === -1, at10.reasons);

  // 9.4 km x 0.35 = 3.29 -> 3.01 dB: the last length that clears the margin
  const at94 = link(LR1, LR1, 9400);
  close(at94.headroomDb, 3.01, 0.001, 'headroom at 9.4 km');
  assert.strictEqual(at94.verdict, 'marginal');

  // ok needs margin + 2 = 5 dB: 1.3 dB of fibre, i.e. 3.714 km, is the last length that reads ok
  const at37 = link(LR1, LR1, 3714);
  close(at37.headroomDb, 5, 0.001, 'headroom at 3.714 km');
  assert.strictEqual(at37.verdict, 'ok');
  const at38 = link(LR1, LR1, 3800);
  assert.strictEqual(at38.verdict, 'marginal', 'past 3.71 km the link is only marginal');
});

test('FR1 leaves less spare than the default margin at its own 2 km', function () {
  // -2.4 - (-6.4) = 4.0 dB; 2 km x 0.35 = 0.7 dB of fibre leaves 3.3 dB
  const bare = link(FR1, FR1, 2000);
  assert.strictEqual(bare.budgetDb, 4, 'the tightest optical budget in the catalogue');
  close(bare.odnLossDb, 0.7, 0.001, 'ODN loss at 2 km');
  close(bare.headroomDb, 3.3, 0.001, 'headroom at 2 km, no terminations');
  assert.strictEqual(bare.verdict, 'marginal');

  // one patch-panel pair at 0.3 dB each: 1.3 dB ODN, 2.7 dB of spare, under the 3 dB margin
  const patched = link(FR1, FR1, 2000, { model: 'sc-apc', count: 2 });
  close(patched.odnLossDb, 1.3, 0.001, '2 km of fibre + two SC/APC matings');
  close(patched.headroomDb, 2.7, 0.001, 'headroom at 2 km with terminations');
  assert.strictEqual(patched.verdict, 'fail');

  // halving the span does not buy the ok verdict: 1 km is 0.35 + 0.6 = 0.95, 3.05 dB of spare
  const at1 = link(FR1, FR1, 1000, { model: 'sc-apc', count: 2 });
  close(at1.headroomDb, 3.05, 0.001, 'headroom at 1 km with terminations');
  assert.strictEqual(at1.verdict, 'marginal', 'FR1 never reads ok at the default 3 dB margin');

  // the reach verdict still binds: 2001 m is outside a 2 km class
  const past = link(FR1, FR1, 2001);
  assert.strictEqual(past.verdict, 'fail');
  assert.ok(past.reasons.join(' ').indexOf('reaches 2000') !== -1, past.reasons);
});

test('a single-lambda LR1 and a 4-lane LR4 are indistinguishable to the engine at 1310 nm', function () {
  // Both rows sit at 1310 nm and 100000 Mb/s, so the pair check accepts a mixed pair and budgets the
  // 4-lane receiver's -10.6 dBm, which the LR1 row cannot actually use. This asserts the limit of a
  // one-wavelength model rather than a refusal that does not happen: pair LR1 with LR1 and read 6.3.
  const mixed = link(LR1, { model: 'qsfp28-100g-lr4-10km' }, 5000, { model: 'sc-apc', count: 2 });
  assert.strictEqual(mixed.budgetDb, 8.7, 'LR1 launch floor into an LR4 receiver');
  assert.strictEqual(mixed.reachM, 10000, 'the shorter optic sets the reach');
  assert.strictEqual(mixed.verdict, 'ok', 'and the pair is accepted');
  const same = link(LR1, LR1, 5000, { model: 'sc-apc', count: 2 });
  assert.strictEqual(same.budgetDb, 6.3, 'LR1 into LR1 is the class figure');
});

done();
