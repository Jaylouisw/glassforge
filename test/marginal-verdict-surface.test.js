'use strict';
// A marginal budget is a decision, so it has to say what it is about - in the engine, not in each
// caller.
//
// `marginal` is the verdict this engine invented for a design inside 2 dB of its margin or with under
// 1 dB of class budget left (docs/SPEC.md section 4). It passed with `reasons: []` - by definition,
// because a reason means `fail` - and an empty `warnings` list, so the verdict was the only trace:
// every caller that wanted to explain it rebuilt the same subtraction by hand (the printed plan did,
// #138 and #139) and the auto-design report built one not at all. A synthesised design whose ONTs all
// landed in the band came back `feasible: true`, ranked as the best candidate, with nothing said.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

/** GPON B+ at 1:64 over 22 km: the marginal band, on the headroom side. */
function ponDesign(overrides) {
  return Object.assign({
    olt: { model: 'gpon-b-plus-8' },
    ont: { model: 'gpon-ont-4ge' },
    wavelength: '1490',
    spans: [{ cable: 'g652d-loose-24', lengthM: 22000 }],
    splitters: [{ model: 'plc-1x64-sca' }],
    splices: 10,
    connectors: 2
  }, overrides || {});
}

test('a marginal budget names the figure it is tight on, and only that figure', function () {
  const r = budget.opticalBudget(ponDesign(), registry);
  // fibre 22 km x 0.22 = 4.84; splices 10 x 0.1 = 1.00; 2 connectors 0.60; 1:64 = 20.50
  //   -> ODN 26.94 dB, class headroom 28 - 26.94 = 1.06 dB
  // rx = 1.5 (B+ minimum launch) - 26.94 = -25.44 dBm; headroom = -25.44 - (-30) = 4.56 dB
  //   4.56 is only 1.56 dB above the 3 dB margin -> marginal on the headroom, class still has 1.06 dB
  close(r.odnLossDb, 26.94, 0.001, 'ODN loss');
  close(r.headroomDb, 4.56, 0.001, 'headroom');
  close(r.classHeadroomDb, 1.06, 0.001, 'class headroom');
  assert.strictEqual(r.verdict, 'marginal');
  assert.strictEqual(r.ok, true, 'marginal still builds');
  assert.strictEqual(r.reasons.length, 0, 'a marginal verdict is not a failure');
  assert.ok(typeof r.marginalReason === 'string' && r.marginalReason.length > 0,
    'a marginal verdict with no sentence is the silence this suite exists for');
  assert.ok(r.marginalReason.indexOf('headroom 4.56 dB is only 1.56 dB above the 3 dB design margin') !== -1,
    r.marginalReason);
  assert.ok(r.marginalReason.indexOf('GPON B+') === -1,
    'the class budget is not tight here, so it must not be named: ' + r.marginalReason);
});

test('a design tight on its class budget instead names the class budget', function () {
  // Same plant at 24 km: fibre 24 x 0.22 = 5.28 -> ODN 27.38 dB, class headroom 0.62 dB.
  // marginDb 0 puts the headroom check out of the band: 4.12 dB of headroom is 4.12 above a 0 dB
  // margin, so only the 0.62 dB of class budget can make this marginal.
  const r = budget.opticalBudget(ponDesign({
    spans: [{ cable: 'g652d-loose-24', lengthM: 24000 }], marginDb: 0
  }), registry);
  close(r.classHeadroomDb, 0.62, 0.001, 'class headroom');
  assert.strictEqual(r.verdict, 'marginal');
  assert.ok(r.marginalReason.indexOf('only 0.62 dB of the GPON B+ budget of 28 dB is left') !== -1,
    r.marginalReason);
  assert.ok(r.marginalReason.indexOf('design margin') === -1,
    'the margin is not what is tight here: ' + r.marginalReason);
});

test('an active link in the band gets the same sentence, with its own budget named', function () {
  const r = budget.pointToPoint({
    headEnd: { model: 'sfp-plus-10g-lr-10km' },
    cpe: { model: 'sfp-plus-10g-lr-10km' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 4000 }],
    splices: 2,
    connectors: 2
  }, registry);
  // 4 km x 0.35 = 1.40, 2 splices 0.20, 2 connectors 0.60 -> ODN 2.20 dB; rx = -8.2 - 2.20 = -10.4 dBm
  // against -14.4 dBm sensitivity -> 4.00 dB of headroom, 1 dB above the 3 dB margin -> marginal
  close(r.headroomDb, 4.0, 0.001, 'headroom');
  assert.strictEqual(r.verdict, 'marginal');
  assert.ok(r.marginalReason.indexOf('headroom 4 dB is only 1 dB above the 3 dB design margin') !== -1,
    r.marginalReason);
});

test('a clean budget and a failing one both stay silent about marginality', function () {
  // The healthy C+ case from budget-optics: ODN 12.16 dB, 20.84 dB of headroom -> ok.
  const ok = budget.opticalBudget({
    olt: { model: 'gpon-c-plus-8' },
    ont: { model: 'gpon-ont-4ge' },
    spans: [{ cable: 'g652d-loose-24', lengthM: 3000 }],
    splitters: [{ model: 'plc-1x8-sca' }],
    splices: 4,
    connectors: 2
  }, registry);
  assert.strictEqual(ok.verdict, 'ok');
  assert.strictEqual(ok.marginalReason, null, 'an ok budget has nothing to explain');

  // 28 km: fibre 6.16 -> ODN 28.26 dB, class headroom -0.26 dB. That is a failure, and a failure is
  // explained by `reasons`; dressing it up as marginal would soften a refusal.
  const fail = budget.opticalBudget(ponDesign({ spans: [{ cable: 'g652d-loose-24', lengthM: 28000 }] }), registry);
  assert.strictEqual(fail.verdict, 'fail');
  assert.ok(fail.reasons.length > 0);
  assert.strictEqual(fail.marginalReason, null, 'a failing budget must not present itself as marginal');
});

// ---------------------------------------------------------------- the auto-design report

const HEAD_END = { lat: 51.5, lon: -0.1 };
const KM = 1 / 111.32;
const PON = { ratios: [64], olt: 'gpon-b-plus-8', ont: 'gpon-ont-4ge' };

test('a synthesised design whose ONT is marginal says so instead of reading as clean', function () {
  // Straight-line routing at routeFactor 1 puts the feeder at about 24 km: 5.27 dB of fibre. With the
  // 1:64 (20.5 dB), the closure splice (0.1), the splitter splice (0.1) and 2 connectors (0.6) the ODN
  // is about 26.7 dB -> about 4.8 dB of headroom, inside 2 dB of the 3 dB margin. Before this suite the
  // report answered `feasible: true` with the structural long-span warning only, so nothing said the
  // design needed a decision.
  const out = engine.design.synthesise(
    [{ label: 'Casa 1', lat: HEAD_END.lat + 24 * KM, lon: HEAD_END.lon }],
    { headEnd: HEAD_END, technology: 'pon', routeFactor: 1.0, pon: PON },
    registry
  );
  const candidate = out.candidates[0];
  const row = candidate.budgets[0];
  assert.strictEqual(row.verdict, 'marginal', JSON.stringify(row));
  assert.ok(/design margin/.test(row.marginalReason),
    'the per-ONT row carries the sentence too: ' + row.marginalReason);
  assert.strictEqual(out.best.feasible, true, 'marginal is not a failure - the candidate stays feasible');
  assert.strictEqual(candidate.metrics.marginalOnts, 1);
  const note = out.best.warnings.filter(function (w) { return /marginally/.test(w); })[0];
  assert.ok(note, 'the chosen design reports no marginal ONT: ' + JSON.stringify(out.best.warnings));
  assert.ok(note.indexOf('Casa 1') !== -1, 'the note names the ONT it is about: ' + note);
  assert.ok(note.indexOf('not a clean plan') !== -1, note);
});

test('a design with room to spare counts no marginal ONTs and warns about none', function () {
  // The same plant at 10 km: 2.2 dB of fibre -> ODN about 23.5 dB -> about 8 dB of headroom, clear.
  const out = engine.design.synthesise(
    [{ label: 'Casa 2', lat: HEAD_END.lat + 10 * KM, lon: HEAD_END.lon }],
    { headEnd: HEAD_END, technology: 'pon', routeFactor: 1.0, pon: PON },
    registry
  );
  assert.strictEqual(out.candidates[0].budgets[0].verdict, 'ok');
  assert.strictEqual(out.candidates[0].metrics.marginalOnts, 0);
  assert.strictEqual(out.best.warnings.filter(function (w) { return /marginally/.test(w); }).length, 0);
});

done();
