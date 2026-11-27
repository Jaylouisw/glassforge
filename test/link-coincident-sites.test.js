'use strict';
// Two sites across one street: both drops land in the same chamber, so the graph has one vertex for
// both ends. `protection` defaults to `diverse`, and asking `street.diversePaths` for two legs between
// one node and itself threw `a link needs two different points on the network` - a refusal that blamed
// the caller for two sites 66 m apart, on the default request, for a link that has a perfectly good
// one-leg answer: 0 m of duct, both site drops, one joint in that chamber.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const link = engine.link;

function p(lat, lon) { return { lat: lat, lon: lon }; }

// A duct running west-east at 51.5000. Both buildings sit 0.0003 deg of latitude off it on the SAME
// meridian, so both project onto one and the same point (51.5000, -0.09955) and one node.
const CORRIDOR = { edges: [{ id: 'duct', coords: [p(51.5000, -0.1020), p(51.5000, -0.0960)] }] };
const A = { name: 'DC-West', lat: 51.5003, lon: -0.09955 };
const B = { name: 'DC-East', lat: 51.4997, lon: -0.09955 };
const ER = { a: 'sfp-plus-10g-er-40km', b: 'sfp-plus-10g-er-40km' };

// 0.0003 deg of latitude is 33.36 m, so the two drops together are 66.72 m and there is no duct in
// between: the leg is 0 m routed + 66.72 m of drop.
const DROP_M = 33.36;

function acrossOneStreet(extra) {
  return link.design(Object.assign({ sites: { a: A, b: B }, network: CORRIDOR, optics: ER }, extra || {}),
    registry);
}

test('two sites on one node are designed on the default (diverse) request, not refused', function () {
  const r = acrossOneStreet();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.legs.length, 1, 'one physical path: one drop each side of one chamber');
  assert.strictEqual(r.legs[0].routedM, 0, 'no duct between the sites');
  close(r.legs[0].spurM, 2 * DROP_M, 0.2, 'both site drops');
  close(r.legs[0].ownM, 2 * DROP_M, 0.2, '0 m of duct + both drops');
  assert.strictEqual(r.protection.achieved, false, 'a shared chamber is not protection');
  assert.strictEqual(r.protection.legs, 1);
  assert.strictEqual(r.diversity.method, 'coincident');
  assert.strictEqual(r.diversity.sharedM, null, 'one leg has nothing to compare its metres with');
});

test('the chamber both drops meet in is a joint, so the BOM orders its closure and its splices', function () {
  const r = acrossOneStreet({ fibres: 2 });
  const leg = r.legs[0];
  assert.strictEqual(leg.joints.length, 1, 'one chamber, one joint');
  close(leg.joints[0].lat, 51.5, 1e-9, 'the joint is the node on the duct');
  close(leg.joints[0].lon, -0.09955, 1e-9, 'the joint is the node on the duct');
  assert.strictEqual(leg.spliceEvents, 1, 'one strand crosses the joint once');
  assert.strictEqual(leg.splices, 2, 'fibres 2 x 1 joint: the crew splices two strands');
  assert.strictEqual(r.bom.closures.count, 1);
  assert.strictEqual(r.bom.splices, 2);
  close(r.bom.cableM, 2 * DROP_M, 0.2, 'the cable bought is the two drops');
});

test('the drawing runs site to site through the chamber, and measures what the BOM buys', function () {
  const r = acrossOneStreet();
  const route = r.legs[0].route;
  assert.strictEqual(route[0].lat, A.lat, 'the route starts at site A');
  assert.strictEqual(route[0].lon, A.lon);
  const last = route[route.length - 1];
  assert.strictEqual(last.lat, B.lat, 'the route ends at site B');
  assert.strictEqual(last.lon, B.lon);
  assert.strictEqual(route.length, 3, 'site A, the chamber, site B');
  close(engine.geo.pathLengthM(route), r.legs[0].ownM, 0.2, 'route metres against ownM');
});

test('the sentence says there is no duct run, not that the graph offers one route', function () {
  const r = acrossOneStreet();
  const sentence = r.diversity.sentence;
  assert.ok(sentence.indexOf('same node on the network') !== -1, sentence);
  assert.ok(sentence.indexOf('51.500000,-0.099550') !== -1, sentence);
  assert.ok(sentence.indexOf('nothing to protect') !== -1, sentence);
  assert.ok(sentence.indexOf('the graph offers a single route') === -1,
    'there is no route to offer: ' + sentence);
  // A circuit asked to be protected and is not: that is a warning, prefixed by the same sentence.
  assert.ok(r.warnings.some(function (w) {
    return w.indexOf('protection was requested but the legs are not diverse: ') === 0;
  }), r.warnings.join(' | '));
  assert.strictEqual(r.notes.filter(function (n) { return n.indexOf('same node on the duct graph') !== -1; }).length, 1,
    r.notes.join(' | '));
});

test('protection single answers the same shape: one leg, the chamber joint, no throw', function () {
  const r = acrossOneStreet({ protection: 'single' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.legs.length, 1);
  assert.strictEqual(r.legs[0].joints.length, 1, 'the splice in the chamber is a joint whoever asked');
  assert.strictEqual(r.bom.closures.count, 1);
  assert.strictEqual(r.diversity.method, 'coincident');
});

test('sites that snap to different nodes still get two legs, so the case does not over-trigger', function () {
  // The same corridor, but the sites are a metre apart along it: two projections, two nodes, and a
  // 1 m duct run between them - a (degenerate) pair, not the coincident case.
  const C = { name: 'DC-West', lat: 51.5000, lon: -0.09960 };
  const D = { name: 'DC-East', lat: 51.5000, lon: -0.09955 };
  const r = link.design({ sites: { a: C, b: D }, network: CORRIDOR, optics: ER }, registry);
  assert.strictEqual(r.legs.length, 2);
  assert.strictEqual(r.diversity.method, 'fewest-shared-metres');
  close(r.legs[0].routedM + r.legs[1].routedM, 6.9, 0.2, 'two legs of the 6.9 m run between them');
});

done();
