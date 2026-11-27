'use strict';
// The active ladder ran 1G, 10G, 25G, 40G, 50G, 100G, 400G with a hole where 200G lives, so a
// 200G site-to-site service had to be quoted as two 100G rows - two duplex pairs and two modules
// for one service, a BOM error no per-link optical verdict would ever flag, because each of the
// two links budgets correctly on its own. IEEE 802.3bs defines 200GBASE-FR4 (2 km) and 802.3cn
// adds 200GBASE-ER4 (40 km); both run four PAM4 lanes on ONE duplex pair near 1300 nm, which is
// the 1310 window every cable here publishes attenuation for.
// These assertions pin the per-lane figures and what the engine does with them: ER4's 18 dB is the
// same class the 50GBASE-ER row spends, its 10 dB class floor puts a pad on a short span, and
// FR4's 4 dB class leaves less than the default 3 dB margin at its own declared 2 km.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const parts = require('../engine/parts');

const registry = parts.createRegistry();
const budget = engine.budget;
const ER = { model: 'qsfp56-200g-er4-40km' };
const FR = { model: 'qsfp56-200g-fr4-2km' };

function link(headEnd, cpe, lengthM, connectors, splices) {
  return budget.pointToPoint({
    headEnd: headEnd,
    cpe: cpe,
    spans: lengthM === 0 ? [] : [{ cable: 'g652d-loose-12', lengthM: lengthM }],
    connectors: connectors === undefined ? 0 : { model: 'sc-apc', count: connectors },
    splices: splices === undefined ? 0 : splices
  }, registry);
}

test('the 200G rung exists, so the ladder no longer jumps from 100G to 400G', function () {
  // The defect the rows exist for: two 100G rows for one 200G service charges two duplex pairs.
  const speeds = registry.all('transceiver').map(function (t) { return t.speedMbps; });
  assert.ok(speeds.indexOf(200000) !== -1, 'a 200G optic must exist: ' + speeds.join(','));
  const twoHundred = registry.all('transceiver').filter(function (t) { return t.speedMbps === 200000; });
  // This used to assert the count was exactly 2, because FR4 (2 km) and ER4 (40 km) were the whole
  // rung then. A count is what a rung outgrows - DR4 (500 m) and LR4 (10 km) landed later - so pin
  // the reach rungs by name: a 200G service is quoted at the same four distances as other speeds.
  assert.deepStrictEqual(
    twoHundred.map(function (t) { return t.reachM; }).sort(function (a, b) { return a - b; }),
    [500, 2000, 10000, 40000],
    'the 200G rung covers 500 m, 2 km, 10 km and 40 km'
  );
  assert.strictEqual(registry.get('transceiver', ER.model).wavelengthNm, 1310, 'four lanes near 1300 nm');
  assert.strictEqual(registry.get('transceiver', FR.model).wavelengthNm, 1310);
});

test('the ER4 row carries the per-lane figures its datasheet and the 802.3cn baseline print', function () {
  // Gigalight GQS-SPO201-ER4CZ, optical characteristics, per lane: launch +0.4..+6.6 dBm,
  // average receive -17.6..-3.4 dBm, OMAouter sensitivity -16.5, stressed -13.3, damage -2.4.
  // ieee802.org/3/cn/public/18_11/xu_3cn_02b_1118.pdf prints the same launch and receive set.
  const er = registry.get('transceiver', 'qsfp56-200g-er4-40km');
  assert.strictEqual(er.model, 'qsfp56-200g-er4-40km', 'model equals the filename');
  assert.strictEqual(er.speedMbps, 200000);
  assert.strictEqual(er.reachM, 40000, 'ER4 is the 40 km rung');
  assert.strictEqual(er.txPowerDbmMin, 0.4, 'average launch MIN per lane is +0.4 dBm');
  assert.strictEqual(er.txPowerDbmMax, 6.6, 'average launch MAX per lane is +6.6 dBm');
  assert.strictEqual(er.rxSensitivityDbm, -17.6, 'average receive MIN per lane, not the -16.5 OMA sensitivity');
  assert.strictEqual(er.rxOverloadDbm, -3.4, 'average receive MAX per lane is -3.4 dBm');
  assert.ok(/^https:\/\//.test(er.sourceUrl), er.sourceUrl);
  assert.ok(er.notes.indexOf('replace the row with the optic actually bought') !== -1, er.notes);
  // 0.4 - (-17.6) = 18.0 dB, ER4's maximum channel insertion loss
  assert.strictEqual(er.txPowerDbmMin - er.rxSensitivityDbm, 18, 'the class is 18 dB');
  // 6.6 - (-3.4) = 10.0 dB, its minimum - which is why a short span needs a pad
  assert.strictEqual(er.txPowerDbmMax - er.rxOverloadDbm, 10, 'the class floor is 10 dB of ODN');
  assert.strictEqual(budget.cableAttenuation(registry.get('cable', 'g652d-loose-12'), '1310'), 0.35);
});

test('a full-reach ER4 link is marginal, and ten splices make it fail', function () {
  // 40 km x 0.35 = 14.0 dB of fibre, + 0.6 dB of two SC/APC matings = 14.6 dB of ODN
  const patched = link(ER, ER, 40000, 2);
  assert.strictEqual(patched.budgetDb, 18);
  close(patched.odnLossDb, 14.6, 0.001, '40 km x 0.35 + 2 x 0.3');
  close(patched.rxPowerDbm, -14.2, 0.001, '0.4 - 14.6');
  close(patched.headroomDb, 3.4, 0.001, '-14.2 against -17.6');
  assert.strictEqual(patched.verdict, 'marginal', '3.4 dB clears the margin but not the 5 dB ok line');

  // ok from 35.43 km patched ((18 - 0.6 - 5) / 0.35); 35.5 km is 4.98 dB and already marginal
  assert.strictEqual(link(ER, ER, 35400, 2).verdict, 'ok');
  assert.strictEqual(link(ER, ER, 35500, 2).verdict, 'marginal');

  // ten fusion splices cost 1.0 dB: 15.6 dB of ODN, 2.4 dB of headroom, under the 3 dB margin
  const spliced = link(ER, ER, 40000, 2, 10);
  close(spliced.odnLossDb, 15.6, 0.001, '14.6 + 10 x 0.1');
  close(spliced.headroomDb, 2.4, 0.001, '18 - 15.6');
  assert.strictEqual(spliced.verdict, 'fail');
  assert.ok(spliced.reasons.join(' ').indexOf('design margin') !== -1, spliced.reasons);

  // 10 km is the comfortable middle: 3.5 dB of fibre + 0.6 = 4.1 dB, 13.9 dB of headroom
  const middle = link(ER, ER, 10000, 2);
  close(middle.odnLossDb, 4.1, 0.001, '10 km x 0.35 + 2 x 0.3');
  assert.strictEqual(middle.verdict, 'ok');
});

test('a short ER4 span fails on overload and is told to fit a 10 dB pad', function () {
  // Launch ceiling +6.6 into a -3.4 dBm receive maximum: 10 dB is the least loss that keeps the
  // far end in range, so a 300 m span (0.7 dB of ODN) overdrives by 9.3 dB.
  const short = link(ER, ER, 300, 2);
  assert.strictEqual(short.verdict, 'fail');
  assert.ok(short.attenuator, 'a 300 m ER4 span must be told to fit a pad');
  assert.strictEqual(short.attenuator.padDb, 10, 'pad sized at the 6.6 dBm top of the launch window');
  assert.strictEqual(short.attenuator.maxPadDb, 14, '18 dB budget, 3 dB margin, 0.7 dB of ODN');
  close(short.attenuator.overDb, 9.3, 0.001, '-0.3 dBm against a -3.4 dBm overload point');
  assert.ok(short.reasons.join(' ').indexOf('overload point -3.4 dBm') !== -1, short.reasons);

  // the verdict reads the declared 0.4 dBm launch, so it stops failing at 3.8 dB of ODN
  // (0.4 + 3.4), i.e. (3.8 - 0.6) / 0.35 = 9.14 km: 9.1 km is 3.785 dB and still overdrives
  assert.strictEqual(link(ER, ER, 9100, 2).verdict, 'fail', '3.785 dB of ODN still overdrives');
  assert.strictEqual(link(ER, ER, 9200, 2).verdict, 'ok', '3.82 dB of ODN clears the overload point');

  // ... and the 10 dB class floor becomes launchWindowPad, the pad a module at the top of its
  // window needs: 6.6 - 0.4 = 6.2 dB over at 9.2 km, and nothing once 10 dB of ODN absorbs it
  const hotModule = link(ER, ER, 9200, 2);
  assert.strictEqual(hotModule.attenuator, null, 'the link is inside range at the declared launch');
  assert.strictEqual(hotModule.launchWindowPad.padDb, 7, 'a 6.18 dB overdrive rounds up to 7 dB');
  assert.strictEqual(link(ER, ER, 26900, 2).launchWindowPad, null, '10.0 dB of ODN is the class floor');
});

test('reach and loss are separate verdicts: 40 001 m is refused on the class reach', function () {
  const past = link(ER, ER, 40001, 2);
  assert.strictEqual(past.verdict, 'fail');
  close(past.headroomDb, 3.4, 0.001, 'the loss budget has not changed by one metre');
  assert.ok(past.reasons.join(' ').indexOf('reaches 40000') !== -1, past.reasons);
});

test('the FR4 row carries its 2 km class figures and never asks for a pad', function () {
  // Gigalight GQS-SPO201-FR4CZB, per lane: launch -4.2..+4.7, average receive -8.2..+4.7,
  // OMAouter sensitivity -6.0, stressed -3.6, damage +5.7. The Hypertec QSFP56-200GB-4FR4-AO
  // sheet prints the same -4.2/+4.7 and -8.2/+4.7.
  const fr = registry.get('transceiver', 'qsfp56-200g-fr4-2km');
  assert.strictEqual(fr.speedMbps, 200000);
  assert.strictEqual(fr.reachM, 2000, 'FR4 is the 2 km rung');
  assert.strictEqual(fr.txPowerDbmMin, -4.2);
  assert.strictEqual(fr.txPowerDbmMax, 4.7);
  assert.strictEqual(fr.rxSensitivityDbm, -8.2, 'average receive MIN, not the -6.0 OMA sensitivity');
  assert.strictEqual(fr.rxOverloadDbm, 4.7, 'average receive MAX equals the launch ceiling');
  assert.ok(/^https:\/\//.test(fr.sourceUrl), fr.sourceUrl);
  // -4.2 - (-8.2) = 4.0 dB, the FR4 class channel insertion loss
  close(fr.txPowerDbmMin - fr.rxSensitivityDbm, 4, 1e-9, 'the class is 4 dB');
  // receive maximum = launch ceiling, so the class floor is 0 dB and no pad is ever proposed
  const backToBack = link(FR, FR, 0);
  close(backToBack.rxPowerDbm, -4.2, 0.001, 'no loss between the optics');
  assert.strictEqual(backToBack.attenuator, null, 'FR4 is not an overload row');
  // 4.0 dB of budget and a 3 dB margin leave 1.0 dB of ODN: a bare patch is already marginal
  close(backToBack.headroomDb, 4, 0.001, '-4.2 against -8.2');
  assert.strictEqual(backToBack.verdict, 'marginal');
});

test('the FR4 declared 2 km is inside the class and under the 3 dB design margin', function () {
  // 2 km x 0.35 = 0.7 dB of fibre, + 0.6 dB of matings = 1.3 dB of ODN, 2.7 dB of headroom:
  // 2.7 dB inside the 4.0 dB class, and 0.3 dB outside the engine's default margin.
  const at2km = link(FR, FR, 2000, 2);
  close(at2km.odnLossDb, 1.3, 0.001, '2 km x 0.35 + 2 x 0.3');
  close(at2km.headroomDb, 2.7, 0.001, '4.0 - 1.3');
  assert.strictEqual(at2km.verdict, 'fail', 'the margin refused it, not the class');
  assert.ok(at2km.reasons.join(' ').indexOf('design margin') !== -1, at2km.reasons);

  // the last length that clears the margin: (4.0 - 0.6 - 3.0) / 0.35 = 1.143 km
  assert.notStrictEqual(link(FR, FR, 1143, 2).verdict, 'fail', '1.143 km leaves exactly 3.0 dB');
  assert.strictEqual(link(FR, FR, 1200, 2).verdict, 'fail', 'past it the margin is gone');
  assert.strictEqual(link(FR, FR, 1000, 2).verdict, 'marginal', '1 km is 3.05 dB, inside the band');

  // the same shape as the 400GBASE-FR4 row: a 4 dB class under a 3 dB margin, not a bad figure
  const fourHundred = link({ model: 'qsfp-dd-400g-fr4-2km' }, { model: 'qsfp-dd-400g-fr4-2km' }, 2000, 2);
  close(fourHundred.headroomDb, 2.8, 0.001, '4.1 - 1.3 on the 400G row');
  assert.strictEqual(fourHundred.verdict, 'fail');
});

test('a 200G optic is refused against an optic of another rate', function () {
  // Four lanes on one pair means the wavelength check cannot separate the rungs; the speed check does.
  let threw = null;
  try {
    link(ER, { model: 'qsfp28-100g-er4-40km' }, 1000);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'a 200G optic into a 100G optic must be refused');
  assert.ok(String(threw.message).indexOf('different rates') !== -1, threw.message);
});

done();
