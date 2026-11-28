'use strict';
// Street routing across the antimeridian: a network whose roads cross longitude 180 is a network, and
// an address on it is reachable. Every length here is a great-circle length (geo.distanceM is already
// wrap-aware); what was not wrap-aware were the planar helpers - the bucket box, the point-to-segment
// projection and the crossing test - so a road drawn across the line was never split at a T-junction
// and every property beside it was refused as "not on the street network or not reachable along it".
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const street = engine.street;
const geo = engine.geo;

const LAT = -17.7;                 // Fiji-ish: a main road along a parallel, a side street south of it
const WEST = 179.9;                // the wrapped estate: 179.9 to -179.9 is 0.2 deg across the line
const SIDE_OFFSET = 0.095;         // side street 0.095 deg east of the west end
const SIDE_LAT = 0.02;             // side street 0.02 deg of latitude long (2,223 m)

// The engine's own great-circle length, so every expectation below is the same arithmetic it bills:
// 0.2 deg of longitude at -17.7 is 21,186 m by geo.distanceM, and 0.2 deg of latitude 22,227 m.
const M_PER_DEG_LON = geo.distanceM({ lat: LAT, lon: 0 }, { lat: LAT, lon: 0.2 }) / 0.2;
const M_PER_DEG_LAT = geo.distanceM({ lat: LAT, lon: 0 }, { lat: LAT + 0.2, lon: 0 }) / 0.2;

/** The same estate, drawn at longitude 10 (control) or across the line when `wraps`. */
function estate(wraps) {
  const mainLon = wraps ? [WEST, -179.9] : [10, 10.2];
  const sideLon = wraps ? WEST + SIDE_OFFSET : 10 + SIDE_OFFSET;
  return {
    edges: [
      { id: 'main', coords: [{ lat: LAT, lon: mainLon[0] }, { lat: LAT, lon: mainLon[1] }] },
      { id: 'side', coords: [{ lat: LAT, lon: sideLon }, { lat: LAT - SIDE_LAT, lon: sideLon }] }
    ],
    headEnd: { lat: LAT, lon: mainLon[0], name: 'PoP' },
    houses: [
      { label: 'h1', lat: LAT - SIDE_LAT / 4, lon: sideLon },
      { label: 'h2', lat: LAT - SIDE_LAT / 2, lon: sideLon }
    ]
  };
}

test('pointToSegmentM measures the short way round the antimeridian', function () {
  // A segment 179.99 -> -179.99 is 0.02 deg = 2,121 m long at this latitude, not 38,000 km.
  const a = { lat: LAT, lon: 179.99 };
  const b = { lat: LAT, lon: -179.99 };
  close(geo.pointToSegmentM({ lat: LAT, lon: 179.995 }, a, b), 0, 1, 'a point on a crossing segment is on it');
  const oneMetreNorth = { lat: LAT + 1 / M_PER_DEG_LAT, lon: 179.995 };
  close(geo.pointToSegmentM(oneMetreNorth, a, b), 1, 0.6, 'one metre north is one metre off');
});

test('projectOnEdge lands on a segment that crosses the antimeridian', function () {
  const graph = street.buildGraph(estate(true));
  const edge = Array.from(graph.edges.values()).find(function (e) {
    return e.geometry.some(function (p) { return p.lon > 0; }) &&
      e.geometry.some(function (p) { return p.lon < 0; });
  });
  assert.ok(edge, 'the main road reaches across the line');
  // Once the side street is planarised the road is two edges; the crossing one runs 179.995 -> -179.9.
  close(edge.lengthM, geo.distanceM(edge.geometry[0], edge.geometry[edge.geometry.length - 1]), 1,
    'an edge measures its own endpoints the short way round');
  close(graph.stats().lengthM, 0.2 * M_PER_DEG_LON + SIDE_LAT * M_PER_DEG_LAT, 2,
    'the whole street is 0.2 deg of longitude plus 0.02 of latitude');
  const found = street.projectOnEdge(edge, { lat: LAT, lon: 179.995 });
  close(found.distM, 0, 1, 'a point on the road projects onto it');
  assert.ok(Math.abs(found.at.lon) <= 180, 'the projection is a longitude, got ' + found.at.lon);
});

test('a side street drawn from a main road across the line is planarised', function () {
  const e = estate(true);
  const graph = street.buildGraph(e.edges);
  const head = street.snap(graph, e.headEnd);
  const house = street.snap(graph, e.houses[1]);
  assert.ok(head && house, 'both ends snap');
  const route = street.routePath(graph, head.nodeId, house.nodeId);
  assert.ok(route, 'a route exists along the street');
  // head -> junction: 0.095 deg lon = 10,075 m; junction -> h2: 0.01 deg lat = 1,111 m
  close(route.lengthM, SIDE_OFFSET * M_PER_DEG_LON + (SIDE_LAT / 2) * M_PER_DEG_LAT, 2, 'routed length');
});

test('the wrapped estate routes like the same estate at longitude 10', function () {
  const control = estate(false);
  const wrapped = estate(true);
  const cg = street.buildGraph(control.edges);
  const wg = street.buildGraph(wrapped.edges);
  const cHead = street.snap(cg, control.headEnd);
  const wHead = street.snap(wg, wrapped.headEnd);
  for (let i = 0; i < control.houses.length; i++) {
    const c = street.snap(cg, control.houses[i]);
    const w = street.snap(wg, wrapped.houses[i]);
    assert.ok(c && w, 'house ' + i + ' snaps on both drawings');
    const cr = street.routePath(cg, cHead.nodeId, c.nodeId);
    const wr = street.routePath(wg, wHead.nodeId, w.nodeId);
    assert.ok(cr && wr, 'house ' + i + ' has a route on both drawings');
    close(wr.lengthM, cr.lengthM, 0.5, 'house ' + i + ' routes the same distance either side of the line');
  }
});

test('two lines that cross at the antimeridian become one network', function () {
  // Neither line has a vertex where they meet: the crossing is at lon 179.99, lat LAT.
  const edges = [
    { id: 'main', coords: [{ lat: LAT, lon: 179.98 }, { lat: LAT, lon: -179.98 }] },
    { id: 'cross', coords: [{ lat: LAT - 0.01, lon: 179.99 }, { lat: LAT + 0.01, lon: 179.99 }] }
  ];
  const graph = street.buildGraph({ edges: edges });
  const head = street.snap(graph, { lat: LAT, lon: 179.98 });
  const house = street.snap(graph, { lat: LAT - 0.005, lon: 179.99 });
  assert.ok(head && house, 'both ends snap');
  const route = street.routePath(graph, head.nodeId, house.nodeId);
  assert.ok(route, 'a crossing at the line joins the two streets');
  // 0.01 deg lon = 1,060 m, then 0.005 deg lat = 556 m
  close(route.lengthM, 0.01 * M_PER_DEG_LON + 0.005 * M_PER_DEG_LAT, 5, 'routed length');
});

test('a vertex at 180 and one at -180 are the same place', function () {
  const edges = [
    { id: 'west', coords: [{ lat: LAT, lon: 179.9 }, { lat: LAT, lon: 180 }] },
    { id: 'east', coords: [{ lat: LAT, lon: -180 }, { lat: LAT, lon: -179.9 }] }
  ];
  const graph = street.buildGraph({ edges: edges });
  // Two lines x 2 points and one shared node = 3 nodes.
  assert.strictEqual(graph.stats().nodes, 3, 'the two 180s are one node');
  const head = street.snap(graph, { lat: LAT, lon: 179.9 });
  const house = street.snap(graph, { lat: LAT, lon: -179.9 });
  const route = street.routePath(graph, head.nodeId, house.nodeId);
  assert.ok(route, 'the road is continuous across 180');
});

test('an auto-design on a wrapped street graph is feasible and prices like the control', function () {
  const registry = engine.createRegistry();
  const opts = function (e) {
    return {
      headEnd: e.headEnd, network: { edges: e.edges }, technology: 'pon',
      pon: { ratios: [8] }, marginDb: 3
    };
  };
  const control = engine.design.synthesise(estate(false).houses, opts(estate(false)), registry);
  const wrapped = engine.design.synthesise(estate(true).houses, opts(estate(true)), registry);
  assert.ok(control.ok, 'the control estate designs');
  assert.ok(wrapped.ok, 'the wrapped estate designs: ' +
    (wrapped.best ? '' : wrapped.candidates.map(function (c) { return c.reasons.join('; '); }).join(' | ')));
  close(wrapped.best.metrics.designM, control.best.metrics.designM, 1, 'same estate, same design length');
});

process.on('exit', function () { done(); });
