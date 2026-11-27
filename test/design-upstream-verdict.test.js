'use strict';
// Auto-design ranked a candidate on half of its link.
//
// A PON is two links over one ODN: the OLT launches into the ONT (1490 nm) and the ONT launches into
// the OLT (1310 nm). `budget.opticalBudget` answers both when asked (`direction: 'up'`), and
// `network.allOntBudgets` passes the flag through - but `evaluate` only ever asked for the default
// direction, so `metrics`, `warnings` and the whole candidate table described the downstream half.
// The ordinary 12-house C+ estate below is `ok` on 12 of 12 ONTs downstream and `fail` on 12 of 12
// upstream (-10.89 dBm at House 3 against the OLT receiver's -12 dBm overload, 1.11 dB over), and the
// report offered it as the best feasible design with nothing said (#185).
//
// This suite pins option 1 of #185: the report counts and names the upstream failures, and the ranking
// does not move. Whether an upstream failure should make a candidate infeasible is the open decision
// in #185/#111 - the ODN class floor is not modelled - so `feasible` must stay what it was.
const { test, assert, close, done } = require('./harness');
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

// Same two seeds as `test/design-launch-window.test.js`: NEAR is the C+ 1:8 estate whose ODN is
// 11.39-11.97 dB, FAR the same topology at ODN 15.73-16.24 dB where neither direction is tight.
const NEAR = { lat: 51.499, lon: -0.1006, name: 'PoP' };
const FAR = { lat: 51.35, lon: -0.1006, name: 'PoP' };

const near = engine.design.synthesise(estate(12), { headEnd: NEAR }, registry);
const far = engine.design.synthesise(estate(12), { headEnd: FAR }, registry);

function upstreamWarnings(result) {
  // 'upstream over the same ODN' is the sentence's own phrase: 'fails upstream' is singular, 'fail
  // upstream' plural, and a filter that pinned one of them counted zero for a one-ONT plant.
  return (result.warnings || []).filter(function (w) { return w.indexOf('upstream over the same ODN') !== -1; });
}

test('a design whose every ONT fails upstream says so once, for the plant', function () {
  const said = upstreamWarnings(near.best);
  assert.strictEqual(said.length, 1, JSON.stringify(near.best.warnings));
  const note = said[0];
  // 12 of 12: the upstream ODN is 11.39-11.97 dB at 1310 nm and the ONT launches +0.5 dBm, so the
  // OLT receiver sees -10.89..-11.47 dBm against its -12 dBm overload point. The ODN is 0.10 dB below
  // what it was before #39 contracted the splitter site's 0 m stub, which counted one closure too many.
  assert.ok(note.indexOf('12 of 12') !== -1, 'names how many ONTs fail upstream: ' + note);
  assert.ok(note.indexOf('House 3') !== -1,
    'names the ONT furthest over the overload point (1.11 dB), not the one with the least headroom: ' + note);
  assert.ok(note.indexOf('-10.89 dBm at the OLT gpon-c-plus-8') !== -1,
    'quotes the power the OLT receiver actually sees: ' + note);
  assert.ok(note.indexOf('6 dB') !== -1, 'names the pad that clears it: ' + note);
  // The pad the band asks for is 4 dB (downstream ceil(3.32)), and 4 dB does not clear the OLT
  // receiver upstream. One pad is ODN loss in both directions, so the larger size is the purchase.
  assert.ok(note.indexOf('serves both directions') !== -1,
    'says that one pad has to satisfy both directions: ' + note);
});

test('the report counts the upstream failures per ONT, and the ranking does not move', function () {
  assert.strictEqual(near.best.metrics.upstreamFailOnts, 12, JSON.stringify(near.best.metrics));
  // #185 option 1: an upstream failure is reported, not a feasibility gate. The choice between
  // reporting and gating is the open decision; flipping `feasible` here would empty auto-design for
  // a short-feed estate and silently change which plant ships.
  assert.strictEqual(near.best.feasible, true, 'feasibility is still the downstream verdict');
  const winner = near.candidates.filter(function (c) { return c.label === near.best.label; })[0];
  assert.ok(winner, 'the winning candidate is not in the table: ' + near.best.label);
  assert.strictEqual(winner.metrics.upstreamFailOnts, 12, JSON.stringify(winner.metrics));
});

test('one ONT row carries both directions, so the two halves cannot be read as one', function () {
  const winner = near.candidates.filter(function (c) { return c.label === near.best.label; })[0];
  const house1 = winner.budgets.filter(function (b) { return b.name === 'House 1'; })[0];
  assert.ok(house1, 'no budget row for House 1: ' + JSON.stringify(winner.budgets[0]));
  assert.strictEqual(house1.verdict, 'ok', 'downstream this ONT is inside its overload point');
  assert.strictEqual(house1.upstreamVerdict, 'fail', JSON.stringify(house1));
  // +0.5 dBm through 11.62 dB of 1310 nm ODN = -11.12 dBm at the OLT receiver.
  close(house1.upstreamRxPowerDbm, -11.12, 0.001, 'upstream receive power');
});

test('a design clear of the upstream band stays silent about it', function () {
  assert.strictEqual(upstreamWarnings(far.best).length, 0, JSON.stringify(far.best.warnings));
  assert.strictEqual(far.best.metrics.upstreamFailOnts, 0, JSON.stringify(far.best.metrics));
  const winner = far.candidates.filter(function (c) { return c.label === far.best.label; })[0];
  assert.ok(winner.budgets.every(function (b) { return b.upstreamVerdict === 'ok'; }),
    'the upstream ODN here is 16.24 dB, 4.24 dB inside the receiver: ' +
    JSON.stringify(winner.budgets.map(function (b) { return b.upstreamVerdict; })));
});

test('the sentence names the head-end optic on an active plant, not an OLT', function () {
  // A 40 km optic launching into an 80 km optic's receiver 2 km down the duct: the pair has 14.78 dB
  // of headroom downstream (-1.02 dBm at the customer optic) and 5.72 dBm at the head-end receiver
  // upstream - 10 dB over its -7 dBm overload, so the link is clean one way and loud the other.
  const up = engine.budget.pointToPoint({
    headEnd: { model: 'sfp-plus-10g-zr-80km' },
    cpe: { model: 'sfp-plus-10g-er-40km' },
    direction: 'up',
    spans: [{ cable: 'g652d-loose-12', lengthM: 2000 }],
    connectors: 2
  }, registry);
  assert.strictEqual(up.verdict, 'fail');
  const note = engine.budget.upstreamNote([{ ont: 'site-b', name: 'Site B', result: up }], { marginDb: 3 });
  assert.ok(note && note.text, 'an upstream failure with no sentence is the silence this suite exists for');
  assert.ok(note.text.indexOf('head-end optic sfp-plus-10g-zr-80km') !== -1, note.text);
  assert.ok(note.text.indexOf('OLT') === -1, 'an active plant has no OLT to blame: ' + note.text);
  assert.strictEqual(note.onts, 1);
  assert.strictEqual(note.total, 1);
});

test('a marginal or clean direction is not reported as a failure', function () {
  const clean = { ont: 'ont-a', name: 'A', result: { verdict: 'ok', reasons: [], technology: 'pon', olt: 'x' } };
  const marginal = { ont: 'ont-b', name: 'B', result: { verdict: 'marginal', reasons: [], marginalReason: 'tight', technology: 'pon', olt: 'x' } };
  assert.strictEqual(engine.budget.upstreamNote([clean, marginal], { marginDb: 3 }), null,
    'marginal passes: a note that calls it a failure is the verdict moving under a caller');
  assert.strictEqual(engine.budget.upstreamNote([], { marginDb: 3 }), null);
  assert.strictEqual(engine.budget.upstreamNote([{ ont: 'ont-c', name: 'C', error: 'no cable model' }], {}), null,
    'a row that could not be budgeted is not an upstream failure');
});

test('an active plant is budgeted upstream too, and the sentence names the head-end optic', function () {
  // 2.7 km of duct between two sites, a 40 km optic at each end's counterpart: the customer optic
  // launches 2.5 dBm into the 80 km optic's -7 dBm receiver at -5.86 dBm (1.14 dB over), while
  // downstream the 80 km optic puts -1.16 dBm on a -15 dBm sensitivity. Clean one way, 10 dB of pad
  // the other - and the engine has to have asked `pointToPoint` for the direction, not just the PON.
  const out = engine.design.synthesise([{ label: 'Site B', lat: 51.52, lon: -0.1 }], {
    headEnd: { lat: 51.5, lon: -0.1, name: 'DC A' },
    technology: 'active',
    active: { optics: [{ headEndOptic: 'sfp-plus-10g-zr-80km', cpeOptic: 'sfp-plus-10g-er-40km' }] }
  }, registry);
  assert.strictEqual(out.best.metrics.upstreamFailOnts, 1, JSON.stringify(out.best.metrics));
  const said = upstreamWarnings(out.best);
  assert.strictEqual(said.length, 1, JSON.stringify(out.best.warnings));
  assert.ok(said[0].indexOf('head-end optic sfp-plus-10g-zr-80km') !== -1,
    'an active link fails at the head-end optic, not at an OLT: ' + said[0]);
  const winner = out.candidates.filter(function (c) { return c.label === out.best.label; })[0];
  close(winner.budgets[0].upstreamRxPowerDbm, -5.86, 0.001, 'head-end receive power');
});
