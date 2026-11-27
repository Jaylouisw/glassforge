'use strict';
// The catalogue had no 50G rung: the active ladder ran 1G, 10G, 25G, 40G, 100G, 400G, so a
// two-site link at 50G had to be quoted as a 25G pair (half the capacity) or a 100G pair (twice
// the price and the same 6.3 dB of channel loss). IEEE 802.3cd-2018 Clause 139 defines
// 50GBASE-LR and IEEE 802.3cn-2019 adds 50GBASE-ER to the same tables, and both are one
// 26.5625 GBd PAM4 carrier at 1310 nm - a window every cable here publishes attenuation for.
// These assertions pin the clause figures and what the engine does with them: LR's 6.3 dB is the
// channel loss 25GBASE-LR and 100GBASE-LR1 also spend, ER's 18 dB leaves 4.0 dB at 40 km, and
// ER's launch floor sits 3.8 dB above its own receive maximum, so a short span fails on overload
// and needs a pad rather than more reach.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const parts = require('../engine/parts');

const registry = parts.createRegistry();
const budget = engine.budget;
const LR = { model: 'qsfp28-50g-lr-10km' };
const ER = { model: 'qsfp28-50g-er-40km' };
const FR = { model: 'qsfp28-50g-fr-2km' };

function link(headEnd, cpe, lengthM, connectors, txDbm) {
  return budget.pointToPoint({
    headEnd: headEnd,
    cpe: cpe,
    spans: [{ cable: 'g652d-loose-12', lengthM: lengthM }],
    connectors: connectors === undefined ? 0 : { model: 'sc-apc', count: connectors },
    splices: 0,
    txDbm: txDbm
  }, registry);
}

test('the LR row carries the launch and receive figures of 802.3cd clause 139', function () {
  // Clause 139, 50GBASE-LR: -4.5..+4.2 dBm average launch, -10.8..+4.2 dBm average receive,
  // 1304.5-1317.5 nm, 10 km, one 26.5625 GBd PAM4 carrier. FS QSFP28-LR-50G and AddOn
  // QSFP-50GB-LR1-AO print the same four numbers.
  const lr = registry.get('transceiver', 'qsfp28-50g-lr-10km');
  assert.strictEqual(lr.speedMbps, 50000, 'a 50G optic, the rung the catalogue was missing');
  assert.strictEqual(lr.wavelengthNm, 1310, 'one carrier at 1310 nm');
  assert.strictEqual(lr.reachM, 10000, 'LR is the 10 km rung');
  assert.strictEqual(lr.txPowerDbmMin, -4.5, 'average launch MIN is -4.5 dBm');
  assert.strictEqual(lr.txPowerDbmMax, 4.2, 'average launch MAX is +4.2 dBm');
  assert.strictEqual(lr.rxSensitivityDbm, -10.8, 'average receive MIN is -10.8 dBm');
  assert.strictEqual(lr.rxOverloadDbm, 4.2, 'average receive MAX is +4.2 dBm');
  assert.ok(/^https:\/\//.test(lr.sourceUrl), lr.sourceUrl);
  assert.ok(lr.notes.indexOf('replace the row with the module actually purchased') !== -1, lr.notes);
  assert.strictEqual(budget.cableAttenuation(registry.get('cable', 'g652d-loose-12'), '1310'), 0.35);
});

test('the ER row carries its 40 km class figures and names the module that is stricter', function () {
  // 802.3cn adds 50GBASE-ER to Tables 139-6/139-7: +0.4..+6.6 dBm launch, -17.6..-3.4 dBm
  // receive, OMA sensitivity -15.1 dBm, 40 km over an APD receiver, KP4 FEC.
  const er = registry.get('transceiver', 'qsfp28-50g-er-40km');
  assert.strictEqual(er.speedMbps, 50000);
  assert.strictEqual(er.wavelengthNm, 1310);
  assert.strictEqual(er.reachM, 40000, 'ER is the 40 km rung');
  assert.strictEqual(er.txPowerDbmMin, 0.4, 'average launch MIN is +0.4 dBm');
  assert.strictEqual(er.txPowerDbmMax, 6.6, 'average launch MAX is +6.6 dBm, the rounded clause figure');
  assert.strictEqual(er.rxSensitivityDbm, -17.6, 'average receive MIN is -17.6 dBm');
  assert.strictEqual(er.rxOverloadDbm, -3.4, 'average receive MAX is -3.4 dBm');
  // 0.4 - (-17.6) = 18.0, the class's channel insertion loss
  assert.strictEqual(er.txPowerDbmMin - er.rxSensitivityDbm, 18, 'the class is 18 dB');
  assert.ok(er.notes.indexOf('-7.0') !== -1, 'the note must name the tighter FS receive maximum: ' + er.notes);
  assert.ok(er.notes.indexOf('-6 dBm damage threshold') !== -1, er.notes);
  assert.ok(er.notes.indexOf('replace the row with the module actually purchased') !== -1, er.notes);
});

test('LR spends the 6.3 dB channel insertion loss, not the 10.3 dB printed power budget', function () {
  // 10.3 dB is the clause's printed power budget; 4.0 dB of it is the PAM4 TDECQ allowance, and
  // the engine compares average launch with average receive, so -4.5 - (-10.8) = 6.3 is all a
  // link may spend - the same reading as 25GBASE-LR and 100GBASE-LR1.
  const at10 = link(LR, LR, 10000);
  assert.strictEqual(at10.budgetDb, 6.3, 'launch floor -4.5 minus sensitivity -10.8');
  close(at10.odnLossDb, 3.5, 0.001, '10 km x 0.35 dB/km');
  close(at10.rxPowerDbm, -8, 0.001, '-4.5 - 3.5');
  close(at10.headroomDb, 2.8, 0.001, '-8.0 against -10.8');
  close(10.3 - at10.budgetDb, 4, 0.001, 'the TDECQ allowance inside the printed power budget');
  assert.strictEqual(at10.verdict, 'fail', '2.8 dB of reserve is under the 3 dB default margin');
  // ... and the margin refused it, not the reach
  assert.ok(at10.reasons.join(' ').indexOf('design margin') !== -1, at10.reasons);
  assert.ok(at10.reasons.join(' ').indexOf('reaches') === -1, at10.reasons);

  // 9.43 km x 0.35 = 3.3 dB of fibre, 3.0 dB of headroom: the last length that clears the margin
  const at943 = link(LR, LR, 9430);
  close(at943.headroomDb, 3, 0.001, 'headroom at 9.43 km');
  assert.strictEqual(at943.verdict, 'marginal');

  // ok needs 5 dB of headroom: 1.3 dB of fibre, i.e. 3.714 km ((6.3 - 5) / 0.35)
  const at3714 = link(LR, LR, 3714);
  close(at3714.headroomDb, 5, 0.001, 'headroom at 3.714 km');
  assert.strictEqual(at3714.verdict, 'ok');
  assert.strictEqual(link(LR, LR, 3800).verdict, 'marginal', 'past 3.71 km the link is only marginal');

  // one patch-panel pair costs 0.6 dB, so the last ok length is 2.0 km ((6.3 - 0.6 - 5) / 0.35)
  assert.strictEqual(link(LR, LR, 2000, 2).verdict, 'ok');
  assert.strictEqual(link(LR, LR, 2100, 2).verdict, 'marginal');
});

test('a full-reach 50GBASE-LR reads fail and a full-reach 50GBASE-ER only marginal', function () {
  // The comparison that decides which rung to buy: ER's 18 dB buys 14.0 dB of fibre at 40 km,
  // while LR's 6.3 dB cannot buy 3.5 dB of fibre at 10 km and still hold the margin.
  const lr10 = link(LR, LR, 10000);
  assert.strictEqual(lr10.verdict, 'fail');
  assert.strictEqual(lr10.reachM, 10000);

  const er40 = link(ER, ER, 40000);
  assert.strictEqual(er40.budgetDb, 18, 'launch floor +0.4 minus sensitivity -17.6');
  close(er40.odnLossDb, 14, 0.001, '40 km x 0.35 dB/km');
  close(er40.rxPowerDbm, -13.6, 0.001, '0.4 - 14.0');
  close(er40.headroomDb, 4, 0.001, '-13.6 against -17.6');
  assert.strictEqual(er40.verdict, 'marginal', '4.0 dB clears the 3 dB margin but not the 5 dB ok line');

  // a patch-panel pair at each end: 14.6 dB of ODN, 3.4 dB of headroom, still marginal
  const erPatched = link(ER, ER, 40000, 2);
  close(erPatched.odnLossDb, 14.6, 0.001, '40 km of fibre + two SC/APC matings at 0.3 dB');
  close(erPatched.headroomDb, 3.4, 0.001, 'headroom at 40 km with terminations');
  assert.strictEqual(erPatched.verdict, 'marginal');

  // ok begins at 35.43 km patched ((18 - 0.6 - 5) / 0.35) and 37.14 km bare ((18 - 5) / 0.35)
  assert.strictEqual(link(ER, ER, 35430, 2).verdict, 'ok');
  assert.strictEqual(link(ER, ER, 35600, 2).verdict, 'marginal');
  assert.strictEqual(link(ER, ER, 37140).verdict, 'ok');

  // reach binds separately: 40001 m is outside the class even with the budget to spare
  const past = link(ER, ER, 40001);
  assert.strictEqual(past.verdict, 'fail');
  assert.ok(past.reasons.join(' ').indexOf('reaches 40000') !== -1, past.reasons);
});

test('ER fails on overload at a short span and asks for a pad, where LR asks for none', function () {
  // 0.4 dBm launch into a -3.4 dBm receive maximum: every span under 3.8 dB of loss overdrives
  // the far end. The pad is sized at the ceiling (6.6 - (-3.4) = 10.0), not at the floor.
  const short = link(ER, ER, 100);
  assert.strictEqual(short.verdict, 'fail');
  assert.ok(short.attenuator, 'a 100 m ER span must be told to fit a pad');
  assert.strictEqual(short.attenuator.padDb, 10, 'pad sized at the top of the launch window');
  assert.strictEqual(short.attenuator.maxPadDb, 14, 'and 14 dB is the most the 18 dB budget and 3 dB margin allow');
  assert.ok(short.reasons.join(' ').indexOf('overload point -3.4 dBm') !== -1, short.reasons);

  // LR's launch ceiling equals its receive maximum, so back-to-back needs no pad at all
  const backToBack = link(LR, LR, 0);
  close(backToBack.rxPowerDbm, -4.5, 0.001, 'no loss between the optics');
  assert.strictEqual(backToBack.attenuator, null, 'LR is not an overload row');
  assert.strictEqual(backToBack.verdict, 'ok');
});

test('the 50G rows are refused against 25G and 100G optics on speed', function () {
  // The one-wavelength model cannot tell 50G-LR from 25G-LR at 1310 nm, so the speed check is what
  // keeps a mixed pair out - the check the four-lane rows cannot give.
  let threw = null;
  try {
    link(ER, { model: 'sfp28-25g-er-40km' }, 1000);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'a 50G optic into a 25G optic must be refused');
  assert.ok(String(threw.message).indexOf('different rates') !== -1, threw.message);
});

test('the FR row is the 2 km rung, and its 4.0 dB budget cannot read ok at the default margin', function () {
  // 802.3cd Tables 139-6/139-7, 50GBASE-FR: -4.1..+3.0 dBm launch, -8.1..+3.0 dBm receive, 2 km,
  // one 26.5625 GBd PAM4 carrier in the same 1304.5-1317.5 nm window as LR. The D2.1 ballot moved
  // the launch floor and the receive minimum together (-3.6/-7.6 -> -4.1/-8.1), so the 4.0 dB a
  // link may spend did not move with them; Huawei’s 50G PAM4 white paper and AscentOptics’
  // SFP-50SM31-02C print the published pair.
  const fr = registry.get('transceiver', 'qsfp28-50g-fr-2km');
  assert.strictEqual(fr.speedMbps, 50000, 'a 50G PAM4 rung');
  assert.strictEqual(fr.wavelengthNm, 1310, 'the window the cables publish attenuation for');
  assert.strictEqual(fr.reachM, 2000, 'FR is the 2 km rung');
  assert.strictEqual(fr.txPowerDbmMin, -4.1, 'average launch MIN is -4.1 dBm');
  assert.strictEqual(fr.txPowerDbmMax, 3, 'average launch MAX is +3.0 dBm');
  assert.strictEqual(fr.rxSensitivityDbm, -8.1, 'average receive MIN is -8.1 dBm');
  assert.strictEqual(fr.rxOverloadDbm, 3, 'average receive MAX is +3.0 dBm');
  // -4.1 - (-8.1) = 4.0, the class channel insertion loss; the printed 7.6 dB power budget carries
  // a 3.6 dB TDECQ allowance on top, which the engine does not spend
  assert.strictEqual(fr.txPowerDbmMin - fr.rxSensitivityDbm, 4, 'the class is 4 dB');
  assert.ok(fr.notes.indexOf('replace the row with the module actually purchased') !== -1, fr.notes);

  // 2 km bare: 0.7 dB of fibre leaves 3.3 dB - over the 3 dB margin, under the 5 dB ok line
  const bare = link(FR, FR, 2000);
  close(bare.odnLossDb, 0.7, 0.001, '2 km x 0.35 dB/km');
  close(bare.rxPowerDbm, -4.8, 0.001, '-4.1 - 0.7');
  close(bare.headroomDb, 3.3, 0.001, '-4.8 against -8.1');
  assert.strictEqual(bare.verdict, 'marginal');

  // one patch-panel pair (0.6 dB) drops it under the margin, and the refusal names sensitivity
  const patched = link(FR, FR, 2000, 2);
  close(patched.odnLossDb, 1.3, 0.001, '0.7 dB of fibre + two SC/APC matings at 0.3 dB');
  close(patched.headroomDb, 2.7, 0.001, '1.3 dB of ODN against a 4.0 dB budget');
  assert.strictEqual(patched.verdict, 'fail');
  assert.ok(patched.reasons.join(' ').indexOf('-8.1 dBm') !== -1, patched.reasons);

  // ok needs margin + 2 = 5 dB and the class offers 4.0 at zero loss, so no FR link is ok by default
  assert.strictEqual(link(FR, FR, 0).verdict, 'marginal', 'even back-to-back');
  const relaxed = budget.pointToPoint({ headEnd: FR, cpe: FR,
    spans: [{ cable: 'g652d-loose-12', lengthM: 2000 }], connectors: { model: 'sc-apc', count: 0 },
    splices: 0, marginDb: 1 }, registry);
  assert.strictEqual(relaxed.verdict, 'ok', 'only a deliberate 1 dB margin makes 2 km ok');

  // reach binds before the budget: 2100 m still has headroom and is refused by name
  const past = link(FR, FR, 2100);
  assert.strictEqual(past.verdict, 'fail');
  assert.ok(past.reasons.join(' ').indexOf('reaches 2000') !== -1, past.reasons);

  // launch ceiling equals the receive maximum, so FR is not an overload row the way ER is
  assert.strictEqual(bare.attenuator, null, 'FR needs no pad');
});

done();
