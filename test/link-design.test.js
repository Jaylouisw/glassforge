'use strict';
// Site-to-site links: two legs routed along a duct graph, diversity stated, leased segments excluded
// from the cable BOM, and one budget verdict per leg.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const link = engine.link;

function p(lat, lon) { return { lat: lat, lon: lon }; }

const A = { name: 'DC-West', lat: 51.5000, lon: -0.1020 };
const B = { name: 'DC-East', lat: 51.5000, lon: -0.0960 };
const ER = { a: 'sfp-plus-10g-er-40km', b: 'sfp-plus-10g-er-40km' };

// A block with no crossing: A and B sit on the same latitude 415.3 m apart, but the street between
// them does not exist, so the only routes are up to the north street or down to the south one.
function grid() {
  return { edges: [
    { id: 'north', coords: [p(51.5010, -0.1020), p(51.5010, -0.0960)] },
    { id: 'south', coords: [p(51.4995, -0.1020), p(51.4995, -0.0960)] },
    { id: 'a-north', coords: [p(51.5000, -0.1020), p(51.5010, -0.1020)] },
    { id: 'a-south', coords: [p(51.5000, -0.1020), p(51.4995, -0.1020)] },
    { id: 'b-north', coords: [p(51.5000, -0.0960), p(51.5010, -0.0960)] },
    { id: 'b-south', coords: [p(51.5000, -0.0960), p(51.4995, -0.0960)] }
  ] };
}

function gridLink(extra) {
  return link.design(Object.assign({ sites: { a: A, b: B }, network: grid(), optics: ER }, extra || {}), registry);
}

test('both legs are routed along the streets, round the junction, not across the block', function () {
  const r = gridLink();
  // 0.006 deg of longitude at 51.5 is 415.3 m; 0.0005 deg of latitude is 55.6 m and 0.001 deg is
  // 111.2 m. South leg = 415.3 + 2 x 55.6 = 526.5 m, north leg = 415.3 + 2 x 111.2 = 637.7 m.
  // The straight line A->B is 415.3 m, so either routed length proves the route went round the block.
  close(r.legs[0].routedM, 526.5, 0.3, 'south leg');
  close(r.legs[1].routedM, 637.7, 0.3, 'north leg');
  const straight = engine.geo.distanceM(A, B);
  close(straight, 415.3, 0.5, 'straight line A->B');
  assert.ok(r.legs[0].routedM > straight + 100, 'a street-routed leg must not equal the chord');
  assert.ok(r.routeMethod.indexOf('street-graph') === 0, r.routeMethod);
  // The geometry is the street: each leg turns at the corner it used, at 51.5010 or 51.4995.
  const corners = r.legs.map(function (leg) {
    return leg.route.some(function (point) {
      return Math.abs(point.lat - 51.5010) < 1e-6 || Math.abs(point.lat - 51.4995) < 1e-6;
    });
  });
  assert.ok(corners[0] && corners[1], 'both legs keep their corner geometry');
});

test('the two legs are edge-disjoint and the report says 0 m shared', function () {
  const r = gridLink();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.protection.achieved, true);
  assert.strictEqual(r.diversity.sharedM, 0);
  assert.strictEqual(r.diversity.shared.length, 0);
  const a = new Set(r.paths[0].edges);
  const b = new Set(r.paths[1].edges);
  for (const edgeId of a) assert.ok(!b.has(edgeId), edgeId + ' is on both legs');
  assert.ok(r.diversity.sentence.indexOf('edge-disjoint') !== -1, r.diversity.sentence);
});

test('a ring graph gives two edge-disjoint legs of equal length', function () {
  const ring = { edges: [
    { id: 'AB', coords: [p(51.5, -0.1), p(51.5, -0.099)] },
    { id: 'BC', coords: [p(51.5, -0.099), p(51.509, -0.099)] },
    { id: 'CD', coords: [p(51.509, -0.099), p(51.509, -0.1)] },
    { id: 'DA', coords: [p(51.509, -0.1), p(51.5, -0.1)] }
  ] };
  const r = link.design({ sites: { a: { name: 'N', lat: 51.5, lon: -0.1 }, b: { name: 'S', lat: 51.509, lon: -0.099 } },
    network: ring, optics: ER }, registry);
  assert.strictEqual(r.diversity.sharedM, 0);
  // Ring: 69.6 m east + 1001.0 m north on either side = 1070.6 m, twice.
  close(r.legs[0].routedM, 1070.6, 1, 'first leg round the ring');
  close(r.legs[1].routedM, 1070.6, 1, 'second leg round the ring');
  assert.notStrictEqual(r.paths[0].edges.join(','), r.paths[1].edges.join(','));
});

test('a single-route graph reports the shared duct by name and metres', function () {
  const corridor = { edges: [{ id: 'duct', coords: [p(51.5, -0.1020), p(51.5, -0.0960)] }] };
  const r = link.design({ sites: { a: A, b: B }, network: corridor, optics: ER }, registry);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.protection.achieved, false);
  // The only route is the whole corridor: 415.3 m of it, shared end to end.
  close(r.diversity.sharedM, 415.3, 0.5, 'shared metres');
  assert.strictEqual(r.diversity.shared[0].edgeId, 'e1');
  assert.ok(r.diversity.sentence.indexOf('diverse except 415.3') === 0, r.diversity.sentence);
  assert.ok(r.warnings.some(function (w) { return w.indexOf('not diverse') !== -1; }), r.warnings.join(' | '));
});

test('the same input produces byte-identical legs', function () {
  const one = JSON.stringify(gridLink());
  const two = JSON.stringify(gridLink());
  assert.strictEqual(one, two);
});

test('a leased segment is budgeted, costed, and never bought as cable', function () {
  const r = gridLink({
    thirdParty: [{ provider: 'CityFibre', lengthM: 300, lossDb: 0.6, cost: 1200, leg: 'b', reference: 'CF-123' }]
  });
  const a = r.legs[0];
  const b = r.legs[1];
  close(a.lengthM, a.ownM, 0.001, 'the A-leg has no leased segment');
  close(b.leasedM, 300, 0.001, 'the B-leg carries the leased 300 m');
  close(b.lengthM, b.ownM + 300, 0.001, 'leased length is in the path length');
  assert.ok(b.budget.breakdown.some(function (line) { return line.kind === 'third-party' && line.db === 0.6; }),
    JSON.stringify(b.budget.breakdown));
  close(a.budget.thirdPartyLossDb, 0, 0.001, 'the A-leg carries no leased loss');
  close(b.budget.thirdPartyLossDb, 0.6, 0.001, 'the leased loss is charged to the leg that uses it');
  // Cable is the owned route only: the leased 300 m is not a purchase.
  close(r.bom.cableM, a.ownM + b.ownM, 0.01, 'cable metres exclude the leased segment');
  assert.strictEqual(r.bom.thirdParty.totalM, 300);
  assert.strictEqual(r.bom.thirdParty.cost, 1200);
  assert.strictEqual(r.bom.thirdParty.inCableBom, false);
  assert.strictEqual(r.thirdParty.segments[0].reference, 'CF-123');
});

test('a leased segment with no stated loss is refused, not assumed lossless', function () {
  throws(function () {
    gridLink({ thirdParty: [{ provider: 'CityFibre', lengthM: 300 }] });
  }, 'never assumed to be zero');
  throws(function () {
    gridLink({ thirdParty: [{ lengthM: 300, lossDb: 0.6 }] });
  }, 'names who owns it');
});

test('a route longer than the optic reaches is refused, naming the length and the reach', function () {
  const longNet = { edges: [{ id: 'trunk', coords: [p(51.0, -0.1), p(51.2, -0.1), p(51.45, -0.1)] }] };
  const r = link.design({
    sites: { a: { name: 'A', lat: 51.0, lon: -0.1 }, b: { name: 'B', lat: 51.45, lon: -0.1 } },
    network: longNet, optics: ER
  }, registry);
  // 0.45 deg of latitude = 50 038 m on a 40 km optic.
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.verdict, 'fail');
  assert.ok(r.reasons.some(function (x) { return x.indexOf('the route is 50038 m but the shorter optic reaches 40000 m') !== -1; }),
    r.reasons.join(' | '));
  assert.ok(r.reasons.every(function (x) { return x.indexOf('A-leg') === 0 || x.indexOf('B-leg') === 0; }),
    'every reason names the leg it belongs to');
});

test('a long-reach optic on a short run fails on overload, not on reach', function () {
  const shortNet = { edges: [{ id: 'cross', coords: [p(51.5, -0.1000), p(51.5, -0.0970)] }] };
  const r = link.design({
    sites: { a: { name: 'A', lat: 51.5, lon: -0.1000 }, b: { name: 'B', lat: 51.5, lon: -0.0970 } },
    network: shortNet, optics: { a: 'sfp-1g-zx-80km', b: 'sfp-1g-zx-80km' }
  }, registry);
  assert.strictEqual(r.verdict, 'fail');
  assert.ok(r.reasons.some(function (x) { return x.indexOf('overload') !== -1; }), r.reasons.join(' | '));
});

test('a leg that passes a junction carries a joint and its splices', function () {
  // Main street west-east with a side street at the midway junction: A and B are both on the main
  // street, and the only route passes through a degree-3 node, which is where a closure goes.
  const tee = { edges: [
    { id: 'main', coords: [p(51.5, -0.1020), p(51.5, -0.0960)] },
    { id: 'side', coords: [p(51.5, -0.0990), p(51.5030, -0.0990)] }
  ] };
  const r = link.design({ sites: { a: A, b: B }, network: tee, optics: ER, protection: 'single' }, registry);
  const leg = r.legs[0];
  assert.strictEqual(leg.joints.length, 1, 'one junction on the route');
  assert.strictEqual(leg.splices, 2, 'two fibres spliced at that joint');
  assert.strictEqual(r.bom.closures.count, 1);
  assert.strictEqual(r.bom.closures.model, 'mufa-inline-24');
});

test('a site off the network is refused by name, not snapped from afar', function () {
  const far = { name: 'DC-Nowhere', lat: 51.53, lon: -0.1020 };
  const r = link.design({ sites: { a: far, b: B }, network: grid(), optics: ER }, registry);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons[0].indexOf('DC-Nowhere') !== -1, r.reasons[0]);
  assert.ok(r.reasons[0].indexOf('not on the network') !== -1, r.reasons[0]);
  assert.strictEqual(r.legs.length, 0);
});

test('without a graph the link is a straight line, and says so instead of faking protection', function () {
  const r = link.design({ sites: { a: A, b: B }, optics: ER }, registry);
  assert.strictEqual(r.routeMethod, 'straight-line x1.2');
  assert.strictEqual(r.legs.length, 1);
  // 415.3 m x 1.2 = 498.4 m, and the route is two points, because there is no street to follow.
  close(r.legs[0].routedM, 498.4, 1, 'straight-line length');
  assert.strictEqual(r.legs[0].route.length, 2);
  assert.strictEqual(r.diversity.achieved, false);
  assert.strictEqual(r.diversity.sharedM, null, 'one leg has nothing to compare against');
  assert.ok(r.diversity.sentence.indexOf('no protected pair') !== -1, r.diversity.sentence);
  assert.strictEqual(r.runs[0].method, 'straight-line x1.2');
  assert.ok(r.notes.some(function (n) { return n.indexOf('No duct/street network supplied') !== -1; }), r.notes.join(' | '));
});

test('two fibres over a short run are drop cable; over 300 m they are not', function () {
  const shortNet = { edges: [{ id: 'cross', coords: [p(51.5, -0.1000), p(51.5, -0.0970)] }] };
  const short = link.design({
    sites: { a: { name: 'A', lat: 51.5, lon: -0.1000 }, b: { name: 'B', lat: 51.5, lon: -0.0970 } },
    network: shortNet, optics: ER, protection: 'single'
  }, registry);
  // 0.003 deg of longitude at 51.5 = 207.7 m: a two-fibre drop.
  assert.strictEqual(short.legs[0].cable, 'g657a2-drop-2');
  assert.strictEqual(short.legs[0].fiberCount, 2);
  // The same two fibres over the 526 m south leg of the grid are a building-to-building cable run.
  assert.strictEqual(gridLink().legs[0].cable, 'g652d-loose-12');
});

test('a link with one end missing is a caller error, not a design', function () {
  throws(function () { link.design({ sites: { a: A }, optics: ER }, registry); }, 'sites.b');
  throws(function () { link.design({ sites: { a: A, b: { name: 'B' } }, optics: ER }, registry); }, 'must be numbers');
  throws(function () { link.design({ sites: { a: A, b: A }, optics: ER }, registry); }, 'two different sites');
  throws(function () { link.design({ sites: { a: A, b: B }, optics: ER, protection: 'maybe' }, registry); }, 'protection must be');
  throws(function () { link.design({ sites: { a: A, b: B }, optics: { a: 'sfp-1g-lx-10km', b: 'sfp-plus-10g-lr-10km' } }, registry); }, 'different rates');
});
