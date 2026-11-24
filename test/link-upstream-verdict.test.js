'use strict';
// A circuit is two links over one path, and `link.design` only ever budgeted one of them.
//
// `budget.pointToPoint` answers either direction - `direction: 'up'` reads the head-end receiver -
// and the module header already said a circuit gets "its own reach, loss and overload verdicts" per
// leg. But the call in `design` passed the requested direction only, defaulting to down, so the
// report described the customer-facing half of every circuit. The case that costs a crew is the
// asymmetric one: a 1G circuit with an LX at the near end and an EX at the far end, on a short duct
// run. Downstream is comfortable - the LX launches -11 dBm. Upstream the EX launches its own floor of
// -1 dBm into the LX receiver's -3 dBm overload point: a 5 dB pad, not more reach, and the report
// said `ok` with no pad at all (#185 is the same gap on the plant surfaces).
//
// This suite pins the treatment, which is #185's option 1 applied to one more surface: the upstream
// direction is budgeted, carried as `legs[].upstream` / `legs[].upstreamVerdict` /
// `upstreamVerdict`, and warned about by name - but `verdict` and `ok` stay the direction the caller
// asked for. Whether an upstream failure should make a design infeasible is still the open decision
// in #185/#111, and a link report does not take it.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const link = engine.link;

const A = { name: 'DC-West', lat: 51.5000, lon: -0.1020 };
// 0.027 deg of latitude is about 3.0 km: long enough that the EX end is clean downstream and short
// enough that the LX receiver is over its overload point when the EX launches into it.
const B = { name: 'DC-East', lat: 51.5270, lon: -0.1020 };

// One duct, straight between the two sites, so the route is the chord and `ownM` is a known length -
// no straight-line x1.2 fallback and no snap spur to argue about.
function duct() {
  return { edges: [{ id: 'trunk', coords: [{ lat: A.lat, lon: A.lon }, { lat: B.lat, lon: B.lon }] }] };
}

function circuit(optics, extra) {
  return link.design(Object.assign({
    sites: { a: A, b: B }, network: duct(), optics: optics, protection: 'single'
  }, extra || {}), registry);
}

const MIXED = { a: 'sfp-1g-lx-10km', b: 'sfp-1g-ex-40km' };
const SYMMETRIC = { a: 'sfp-plus-10g-er-40km', b: 'sfp-plus-10g-er-40km' };

function upstreamWarnings(result) {
  return (result.warnings || []).filter(function (w) { return w.indexOf('fails upstream over the same path') !== -1; });
}

test('a circuit that fails only when read from the far end says so, and names the pad', function () {
  const r = circuit(MIXED);
  const leg = r.legs[0];
  // Downstream: the LX launches -11 dBm. 3.0 km of G.652.D at 0.35 dB/km = 1.05 dB, plus two
  // connectors at 0.3 dB = 0.6 dB, so the EX receiver sees about -12.65 dBm against -22 dBm
  // sensitivity and +1 dBm overload: ok, no pad.
  assert.strictEqual(leg.budget.direction, 'down');
  assert.strictEqual(leg.verdict, 'ok', JSON.stringify(leg.budget.reasons));
  assert.strictEqual(leg.budget.attenuator, null);
  // Upstream: the EX launches its floor of -1 dBm over the same 1.65 dB, so the LX receiver sees
  // -2.65 dBm against its -3 dBm overload point - over, and the pad that clears it is sized at the
  // EX's +3 dBm ceiling (5 dB).
  assert.strictEqual(leg.upstream.direction, 'up');
  assert.strictEqual(leg.upstreamVerdict, 'fail');
  close(leg.upstream.rxPowerDbm, -2.65, 0.02, 'upstream receive power');
  assert.strictEqual(leg.upstream.overloadDbm, -3);
  const upReasons = leg.upstream.reasons.join(' ');
  assert.ok(upReasons.indexOf('above its overload point -3 dBm') !== -1, upReasons);
  assert.ok(upReasons.indexOf('5 dB inline pad') !== -1, 'the upstream reason names the pad: ' + upReasons);

  assert.strictEqual(r.upstreamVerdict, 'fail');
  // Reported, not gated: #185's option 1, pinned so a later change of policy is a deliberate one.
  assert.strictEqual(r.verdict, 'ok', 'the circuit verdict is the direction that was asked for');
  assert.strictEqual(r.ok, true);

  const said = upstreamWarnings(r);
  assert.strictEqual(said.length, 1, JSON.stringify(r.warnings));
  assert.ok(said[0].indexOf('A-leg:') === 0, 'the warning names the leg: ' + said[0]);
  assert.ok(said[0].indexOf('-2.65 dBm at the head-end optic sfp-1g-lx-10km') !== -1,
    'quotes the power the head-end receiver sees: ' + said[0]);
  assert.ok(said[0].indexOf('5 dB inline pad') !== -1, 'carries the fix, not just the fault: ' + said[0]);
  // Downstream asks for no pad here, so there is nothing to reconcile and the sentence stays silent
  // about buying a larger one.
  assert.ok(said[0].indexOf('buy the larger') === -1, said[0]);
});

test('both directions are the same glass: one ODN loss, two launches', function () {
  const r = circuit(MIXED);
  const leg = r.legs[0];
  assert.strictEqual(leg.upstream.odnLossDb, leg.budget.odnLossDb, 'one path of glass');
  assert.strictEqual(leg.upstream.totalLossDb, leg.budget.totalLossDb);
  assert.notStrictEqual(leg.upstream.txDbm, leg.budget.txDbm,
    'the launch powers differ, which is the point: ' + leg.budget.txDbm + ' down');
  assert.notStrictEqual(leg.upstream.sensitivityDbm, leg.budget.sensitivityDbm,
    'and a different receiver reads the other end');
});

test('a symmetric circuit carries the upstream verdict and says nothing', function () {
  const r = circuit(SYMMETRIC);
  assert.strictEqual(r.verdict, 'ok');
  assert.strictEqual(r.legs[0].upstreamVerdict, 'ok');
  assert.strictEqual(r.legs[0].upstream.verdict, 'ok');
  assert.strictEqual(r.upstreamVerdict, 'ok');
  assert.strictEqual(upstreamWarnings(r).length, 0, JSON.stringify(r.warnings));
});

test('asking for the upstream direction reports it once, not as a second warning', function () {
  const r = circuit(MIXED, { direction: 'up' });
  const leg = r.legs[0];
  // The caller asked for the up direction, so it is the report's own budget - one object, never a
  // second call that could describe a different loss.
  assert.strictEqual(leg.upstream, leg.budget);
  assert.strictEqual(leg.budget.direction, 'up');
  assert.strictEqual(r.verdict, 'fail');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.upstreamVerdict, 'fail');
  // The failure is already the verdict and the reason; a warning repeating it would read as a second
  // fault on the same leg.
  assert.strictEqual(upstreamWarnings(r).length, 0, JSON.stringify(r.warnings));
});

test('each leg of a protected circuit carries its own upstream verdict', function () {
  const grid = { edges: [
    { id: 'north', coords: [{ lat: 51.5010, lon: -0.1020 }, { lat: 51.5010, lon: -0.0960 }] },
    { id: 'south', coords: [{ lat: 51.4995, lon: -0.1020 }, { lat: 51.4995, lon: -0.0960 }] },
    { id: 'a-north', coords: [{ lat: 51.5000, lon: -0.1020 }, { lat: 51.5010, lon: -0.1020 }] },
    { id: 'a-south', coords: [{ lat: 51.5000, lon: -0.1020 }, { lat: 51.4995, lon: -0.1020 }] },
    { id: 'b-north', coords: [{ lat: 51.5000, lon: -0.0960 }, { lat: 51.5010, lon: -0.0960 }] },
    { id: 'b-south', coords: [{ lat: 51.5000, lon: -0.0960 }, { lat: 51.4995, lon: -0.0960 }] }
  ] };
  const sites = { a: { name: 'DC-West', lat: 51.5000, lon: -0.1020 }, b: { name: 'DC-East', lat: 51.5000, lon: -0.0960 } };
  // The EX's -1 dBm launch into an LX receiver's -3 dBm overload point is over on both legs of this
  // block (526.5 m and 637.7 m), so both legs warn, each with its own label.
  const r = link.design({ sites: sites, network: grid, optics: MIXED }, registry);
  assert.strictEqual(r.legs.length, 2);
  assert.deepStrictEqual(r.legs.map(function (leg) { return leg.upstreamVerdict; }), ['fail', 'fail']);
  assert.strictEqual(r.upstreamVerdict, 'fail');
  const said = upstreamWarnings(r);
  assert.strictEqual(said.length, 2, JSON.stringify(r.warnings));
  assert.ok(said[0].indexOf('A-leg:') === 0, said[0]);
  assert.ok(said[1].indexOf('B-leg:') === 0, said[1]);
  // The nearer leg is the louder one, so the power in each sentence is that leg's own figure and not
  // a plant average.
  const first = Number(said[0].match(/(-?\d+\.\d+) dBm/)[1]);
  const second = Number(said[1].match(/(-?\d+\.\d+) dBm/)[1]);
  assert.ok(first > second, 'the shorter leg sees more power: ' + first + ' vs ' + second);
});

test('a link that cannot be routed answers upstreamVerdict null, not a verdict nobody computed', function () {
  const r = link.design({
    sites: { a: A, b: { name: 'DC-Offset', lat: 51.6, lon: -0.30 } },
    network: duct(),
    optics: MIXED
  }, registry);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.legs.length, 0);
  assert.strictEqual(r.upstreamVerdict, null);
});

done();
