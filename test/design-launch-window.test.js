'use strict';
// The launch-window blind zone must survive to the design report, not only to a single budget.
//
// #111 and PR #118 taught `budget.opticalBudget` to say "the ONT is inside its overload point only at
// the bottom of the OLT launch window" and every project surface to repeat it. Auto-design is the
// surface that *proposes* a plan, and it computed each ONT's budget, read the verdict, and threw the
// warnings away: the ordinary 12-house C+ estate below is 12 of 12 ONTs inside the band, 3.55 dB over
// at the top of the launch window, and `synthesise` reported `feasible: true, warnings: []`. A plan
// signed off on a link that only works while every line card lands cold is the failure #111 is about.
//
// This suite pins the two halves: the design report counts and names the band, and a design clear of
// it stays silent. The verdict must not move (#111's decision is still Jay's): every candidate here is
// feasible before and after.
const { test, assert, close, done } = require('./harness');
const fs = require('fs');
const path = require('path');
const engine = require('../engine');

const registry = engine.createRegistry();

/** A short street of houses, all within a few hundred metres of the head-end. */
function estate(n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({ label: 'House ' + (i + 1), lat: 51.5 + i * 0.0004, lon: -0.1 + Math.sin(i / 5) * 0.0004 });
  }
  return points;
}

// 0.001 deg south of the first house: the C+ 1:8 design lands at ODN 11.46-11.97 dB, inside the
// 11.0-15.0 dB band where a +3 dBm floor is clean (-8.68 dBm at House 1, 0.68 dB inside the -8 dBm
// overload point) and a +7 dBm ceiling is not (-4.68 dBm, 3.32 dB over).
const NEAR = { lat: 51.499, lon: -0.1006, name: 'PoP' };
// 0.15 deg south: the same topology at ODN 15.83-16.34 dB, past the top of the band, so nothing to say.
const FAR = { lat: 51.35, lon: -0.1006, name: 'PoP' };

const near = engine.design.synthesise(estate(12), { headEnd: NEAR }, registry);
const far = engine.design.synthesise(estate(12), { headEnd: FAR }, registry);

function bandWarnings(result) {
  return (result.warnings || []).filter(function (w) { return w.indexOf('launch window') !== -1; });
}

test('a synthesised design whose ONTs all sit in the blind zone reports it', function () {
  assert.strictEqual(near.best.feasible, true, 'the verdict is still the floor launch: ' + JSON.stringify(near.best.warnings));
  const loud = bandWarnings(near.best);
  assert.strictEqual(loud.length, 1, JSON.stringify(near.best.warnings));
  assert.ok(loud[0].indexOf('12 of 12') !== -1, 'names how many ONTs the band covers: ' + loud[0]);
  assert.ok(loud[0].indexOf('3.55 dB over at the 7 dBm') !== -1,
    'names the worst overshoot and the launch it happens at: ' + loud[0]);
  assert.ok(loud[0].indexOf('4 dB of inline pad') !== -1, 'ceil(3.55) = 4, and the fix must be named: ' + loud[0]);
});

test('the design report counts the band per ONT as well as saying it once', function () {
  assert.strictEqual(near.best.metrics.launchWindowOnts, 12, JSON.stringify(near.best.metrics));
  // The per-ONT table is the candidate's, and the winner is one of the candidates - the design report
  // says the band once for the plant and leaves the arithmetic on the row that computed it.
  const winner = near.candidates.filter(function (c) { return c.label === near.best.label; })[0];
  assert.ok(winner, 'the winning candidate is not in the table: ' + near.best.label);
  assert.strictEqual(winner.budgets.length, 12);
  winner.budgets.forEach(function (row) {
    assert.ok(row.launchWindowPad, row.name + ' lost the pad its own budget computed');
    assert.strictEqual(row.launchWindowPad.padDb, Math.ceil(row.launchWindowPad.overDb),
      row.name + ': pads are whole dB, so padDb is ceil(overDb)');
    assert.strictEqual(row.launchWindowPad.fits, true, row.name + ': 4 dB of pad is inside the C+ budget');
    assert.strictEqual(row.verdict, 'ok', row.name + ': a band that only bites a hot module must not fail a design');
  });
});

test('a design clear of the band carries no launch-window warning', function () {
  assert.strictEqual(far.best.feasible, true, JSON.stringify(far.best.warnings));
  assert.strictEqual(far.best.metrics.launchWindowOnts, 0, JSON.stringify(far.best.metrics));
  assert.strictEqual(bandWarnings(far.best).length, 0, JSON.stringify(far.best.warnings));
});

// The structured field the design report counts is the budget's own, so a direct caller gets it too -
// and it is the *other* half of `attenuator`: one says the link is too loud at its floor launch, the
// other says it is only too loud once the module runs hot. A budget never reports both.
const DESIGN = {
  olt: { model: 'gpon-c-plus-8' }, ont: { model: 'gpon-ont-4ge' },
  spans: [{ cable: 'g652d-loose-24', lengthM: 3000 }],
  splitters: [{ model: 'plc-1x8-sca' }], splices: 4, connectors: 2
};

test('the budget result carries the hot-launch pad separately from the floor-launch pad', function () {
  // 3 km x 0.22 = 0.66 + 10.50 splitter + 4 x 0.10 + 2 x 0.30 = 12.16 dB of ODN, so -9.16 dBm at the
  // 3 dBm floor (inside -8) and -5.16 dBm at the 7 dBm ceiling (2.84 dB over, so a 3 dB pad).
  const r = engine.budget.opticalBudget(DESIGN, registry);
  assert.strictEqual(r.attenuator, null, 'nothing is too loud at the floor launch');
  assert.ok(r.launchWindowPad, 'the ceiling launch is too loud, so the design needs a pad to hold there');
  close(r.launchWindowPad.overDb, 2.84, 0.001, 'overDb');
  assert.strictEqual(r.launchWindowPad.padDb, 3);
  assert.strictEqual(r.launchWindowPad.atTxDbm, 7);

  // The same splitter and 100 m of the same cable with no splice or connector: 10.50 + 0.02 = 10.52 dB
  // of ODN, so -7.52 dBm at the floor launch is already 0.48 dB over the overload point - a pad is
  // needed whatever the module does, and the band warning has nothing to add.
  const tooLoud = engine.budget.opticalBudget(Object.assign({}, DESIGN, {
    spans: [{ cable: 'g652d-loose-24', lengthM: 100 }], splices: 0, connectors: 0
  }), registry);
  assert.strictEqual(tooLoud.verdict, 'fail');
  assert.ok(tooLoud.attenuator, 'a floor-launch overload reports the pad in attenuator');
  assert.strictEqual(tooLoud.launchWindowPad, null, 'the two fields are exclusive: one fault, one field');
});

test('a point-to-point budget carries the same field', function () {
  // ZX over 15 km of G.652.D: 15 x 0.21 = 3.15 + 0.60 connectors = 3.75 dB, so -3.75 dBm at the 0 dBm
  // floor (0.75 dB inside the -3 dBm overload) and +1.25 dBm at the 5 dBm ceiling (4.25 dB over).
  const r = engine.budget.pointToPoint({
    headEnd: { model: 'sfp-1g-zx-80km' }, cpe: { model: 'sfp-1g-zx-80km' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 15000 }], splices: 0, connectors: 2
  }, registry);
  assert.strictEqual(r.attenuator, null);
  assert.ok(r.launchWindowPad, JSON.stringify(r.warnings));
  close(r.launchWindowPad.overDb, 4.25, 0.001, 'overDb');
  assert.strictEqual(r.launchWindowPad.padDb, 5);
  assert.strictEqual(r.launchWindowPad.atTxDbm, 5);
});

// The Auto tab is where a planner reads the proposal. It rendered the label, the rationale and the
// candidate table, and never `best.warnings`, so the engine's sentence about the band stopped at the
// JSON - the same bug #118 fixed for the Signal tab. The app is an IIFE with no exports, so the guard
// is that the card reads the field the engine fills; the rendering itself was checked on the real page.
test('the Auto tab renders the winning design warnings', function () {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const start = app.indexOf('function renderAuto');
  assert.ok(start !== -1, 'renderAuto not found');
  const end = app.indexOf('function autoPayload');
  const card = app.slice(start, end === -1 ? app.length : end);
  assert.ok(card.indexOf('best.warnings') !== -1,
    'renderAuto drops best.warnings, so the blind zone is invisible on the tab that proposes the design');
});

done();
