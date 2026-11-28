'use strict';
// A street import has to planarise in the time an import can wait for, and the indexed vertex pass
// has to find every junction the full scan found.
//
// `splitAtInteriorVertices` tested every node against every edge - V x E, quadratic in the drawing.
// On a 100 x 100 grid of 100 m streets (10,000 nodes, 19,800 edges, a 10 km town at 100 m spacing)
// that was 34,618 ms on this machine on 2026-11-28 (gh#226), and no design runs until the import
// returns. The edges are now bucketed by the cells their bounding box covers, and a node visits only
// the cells its tolerance box covers; the cases below are the contract - a junction is cut wherever
// it falls in a cell, a junction onto a 15 km edge is still found, the clock holds, and two imports
// of one drawing produce one graph.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const street = engine.street;
const geo = engine.geo;

const BASE_LAT = 51.5;
const BASE_LON = -0.1;
const SPACING_M = 100;

/** One polyline per street, a vertex at every crossing: the drawing an exporter writes and the shape
 * the issue measured. 2n lines, n x n nodes, 2n(n-1) edges. */
function gridInput(n) {
  const dLat = SPACING_M / 111132.95;
  const dLon = SPACING_M / (111319.49 * Math.cos(BASE_LAT * Math.PI / 180));
  const lines = [];
  for (let r = 0; r < n; r++) {
    const coords = [];
    for (let c = 0; c < n; c++) coords.push({ lat: BASE_LAT + r * dLat, lon: BASE_LON + c * dLon });
    lines.push({ id: 'h' + r, coords: coords });
  }
  for (let c = 0; c < n; c++) {
    const coords = [];
    for (let r = 0; r < n; r++) coords.push({ lat: BASE_LAT + r * dLat, lon: BASE_LON + c * dLon });
    lines.push({ id: 'v' + c, coords: coords });
  }
  return { edges: lines };
}

/** A main road 400 m long with vertices every 100 m, and a side street drawn north from a point on
 * it. Returns the inputs; the junction longitude picks where the side street leaves the main road. */
function tJunction(junctionLon) {
  const main = [];
  for (let i = 0; i <= 4; i++) main.push({ lat: BASE_LAT, lon: BASE_LON + i * 0.0002 });
  const side = [{ lat: BASE_LAT, lon: junctionLon }, { lat: BASE_LAT + 0.001, lon: junctionLon }];
  return { edges: [{ id: 'main', coords: main }, { id: 'side', coords: side }] };
}

const MAIN_WEST = { lat: BASE_LAT, lon: BASE_LON };
const SIDE_END = { lat: BASE_LAT + 0.001, lon: -0.09925 };

test('a 10,000-node street import planarises in the time an import can wait for', function () {
  const input = gridInput(100);
  const started = Date.now();
  const graph = street.buildGraph(input);
  const elapsed = Date.now() - started;
  const stats = graph.stats();
  assert.strictEqual(stats.nodes, 10000, 'every crossing of the grid is one node');
  assert.strictEqual(stats.edges, 19800, '99 segments on each of 100 rows and 100 columns');
  // 19,800 spacings of 100 m, measured by haversine on a degree grid: within 0.25% of nominal.
  close(stats.lengthM, 19800 * SPACING_M, 19800 * SPACING_M * 0.0025, 'grid length');
  // The indexed pass took 189 ms on this graph in this suite's own run on 2026-11-28 and the full
  // scan 34,618 ms, so the ceiling is a guard with an order of magnitude of headroom, not a
  // stopwatch: a runner slow enough to trip it is one where the scan took minutes.
  assert.ok(elapsed < 5000, 'the 100 x 100 import took ' + elapsed + ' ms, over the 5,000 ms ceiling');
});

test('a side street drawn from the middle of a main road becomes a junction, not an island', function () {
  // The junction at -0.09925 falls halfway between the main road vertices at -0.0994 and -0.0990,
  // so only the vertex pass can put a node there - the side street shares no vertex with the road.
  const graph = street.buildGraph(tJunction(-0.09925));
  // 5 main vertices + the junction the split creates + the side street far end.
  assert.strictEqual(graph.stats().nodes, 7, 'the main road is cut at the junction');
  const west = street.snap(graph, MAIN_WEST);
  const north = street.snap(graph, SIDE_END);
  assert.ok(west && north, 'both ends snap onto the street');
  const route = street.routePath(graph, north.nodeId, west.nodeId);
  assert.ok(route, 'the side street reaches the main road - before the split it was a separate component');
  // Side street 0.001 deg of latitude north, plus the 0.00175 deg of longitude along the road from
  // the junction back to the west end. Derived from the coordinates, not from a previous run.
  const junction = { lat: BASE_LAT, lon: -0.09925 };
  const expected = geo.distanceM(SIDE_END, junction) + geo.distanceM(junction, MAIN_WEST);
  close(route.lengthM, expected, 0.5, 'route through the junction');
});

test('the junction is found wherever it falls inside an index cell', function () {
  // Ten positions across one 100 m segment, so a junction lands near either edge of the 100 m index
  // cell and at every spacing in between: a candidate lookup that misses one cell would lose one of
  // these, and the side street would come back unreachable.
  const segment = 0.0002; // 13.9 m; the index cell is 100 m, so these positions share a cell
  for (let step = 0; step < 10; step++) {
    // 0.15 to 0.825 along the segment: at least 2 m clear of either main vertex, so the join
    // tolerance cannot merge the side street into one of them and hide the split.
    const lon = BASE_LON + segment * 2 + segment * (0.15 + step * 0.075);
    const graph = street.buildGraph(tJunction(lon));
    const west = street.snap(graph, MAIN_WEST);
    const side = street.snap(graph, { lat: BASE_LAT + 0.001, lon: lon });
    const route = street.routePath(graph, side.nodeId, west.nodeId);
    assert.ok(route, 'a junction at ' + lon.toFixed(7) + ' must be cut');
    assert.strictEqual(graph.stats().nodes, 7, 'one junction node at ' + lon.toFixed(7));
  }
});

test('a junction onto a 15 km edge that spans a hundred index cells is still found', function () {
  // One two-point edge 15 km long: its bounding box covers a hundred 100 m cells, and the side
  // street leaves it in the middle. The node cell must still find the edge in its bucket.
  const longEdge = [{ lat: BASE_LAT, lon: BASE_LON }, { lat: BASE_LAT, lon: BASE_LON + 0.22 }];
  const sideAt = BASE_LON + 0.1234;
  const graph = street.buildGraph({
    edges: [{ id: 'long', coords: longEdge },
      { id: 'side', coords: [{ lat: BASE_LAT, lon: sideAt }, { lat: BASE_LAT + 0.001, lon: sideAt }] }]
  });
  assert.strictEqual(graph.stats().nodes, 4, 'two endpoints, the junction, and the side street end');
  const east = street.snap(graph, { lat: BASE_LAT, lon: BASE_LON + 0.22 });
  const north = street.snap(graph, { lat: BASE_LAT + 0.001, lon: sideAt });
  const route = street.routePath(graph, north.nodeId, east.nodeId);
  assert.ok(route, 'the far end of the 15 km edge is reachable from the side street');
  const junction = { lat: BASE_LAT, lon: sideAt };
  const expected = geo.distanceM(junction, { lat: BASE_LAT, lon: BASE_LON + 0.22 }) +
    geo.distanceM({ lat: BASE_LAT + 0.001, lon: sideAt }, junction);
  close(route.lengthM, expected, 0.5, 'route along the long edge');
});

test('two imports of one jittered drawing produce the same graph', function () {
  // A grid whose rows are offset half a vertex from each other: the two families of lines cross
  // between vertices, so the crossing pass and the vertex pass both run, and the split order is what
  // a re-run has to reproduce.
  const dLat = 0.0009;
  const dLon = 0.0014;
  const lines = [];
  for (let r = 0; r < 20; r++) {
    const coords = [];
    for (let c = 0; c < 20; c++) coords.push({ lat: BASE_LAT + r * dLat, lon: BASE_LON + c * dLon + (r % 2) * 0.00007 });
    lines.push({ id: 'h' + r, coords: coords });
  }
  for (let c = 0; c < 20; c++) {
    const coords = [];
    for (let r = 0; r < 20; r++) coords.push({ lat: BASE_LAT + r * dLat, lon: BASE_LON + c * dLon });
    lines.push({ id: 'v' + c, coords: coords });
  }
  const one = street.buildGraph({ edges: lines });
  const two = street.buildGraph({ edges: lines.slice() });
  assert.deepStrictEqual(one.stats(), two.stats(), 'same counts and length twice');
  assert.ok(one.stats().nodes > 400, 'the crossings added nodes beyond the 400 drawn vertices');
});

done();
