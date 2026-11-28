'use strict';
// The import's planarise pass: one bucket per edge, not every node against every edge.
//
// `splitAtInteriorVertices` used to test all V nodes against all E edges. The bounding box made each
// test cheap, but the pair count is quadratic: a 10,000-node town (100 x 100 junctions at 100 m)
// took 27 s on this host and 44.6 s on the machine that filed gh#226. The fix registers each edge in
// the 200 m cells its bounding box covers and asks only for the cells a node's +/-tol box touches, so
// the pass is linear in (nodes + edges).
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const street = engine.street;

const LAT_M = 111132.95;
const STEP_M = 100;
const REF_LAT = 51.5;
const LAT_STEP = STEP_M / LAT_M;
const LON_STEP = STEP_M / (111319.49 * Math.cos((REF_LAT * Math.PI) / 180));
const REF_LON = -0.1;

/** A town: `n` north-south and `n` east-west polylines, all sharing junction vertices exactly. */
function town(n) {
  const edges = [];
  for (let row = 0; row < n; row++) {
    const coords = [];
    for (let col = 0; col < n; col++) coords.push({ lat: REF_LAT + row * LAT_STEP, lon: REF_LON + col * LON_STEP });
    edges.push({ id: 'row' + row, coords: coords });
  }
  for (let col = 0; col < n; col++) {
    const coords = [];
    for (let row = 0; row < n; row++) coords.push({ lat: REF_LAT + row * LAT_STEP, lon: REF_LON + col * LON_STEP });
    edges.push({ id: 'col' + col, coords: coords });
  }
  return { edges: edges };
}

test('a 10,000-node town imports in seconds, not minutes', function () {
  const started = Date.now();
  const graph = street.buildGraph(town(100));
  const elapsedMs = Date.now() - started;
  const stats = graph.stats();
  // 100 x 100 junctions; each of 200 polylines carries 99 spans = 19,800 edges.
  assert.strictEqual(stats.nodes, 10000, 'junction nodes');
  assert.strictEqual(stats.edges, 19800, 'street spans');
  // 19,800 x 100 m = 1,978,480 m, measured on the great-circle formula the engine uses.
  close(stats.lengthKm, 1978.48, 1, 'town length, km');
  // Quadratic was 27 s here and 44.6 s when the issue was filed; bucketed is 0.18 s. The ceiling is
  // 25x the measured time so a slow CI runner is not the thing that fails, and 5x below the old cost
  // so a regression to the scan cannot pass.
  assert.ok(elapsedMs < 5000, 'town import took ' + elapsedMs + ' ms, expected under 5000 ms');
});

// The index is only correct if a T-junction lands in a candidate bucket even when it sits within a
// metre of a bucket edge - 200 m cells, junctions at 199.5 m and 200.5 m straddle exactly that line.
test('a side street drawn from a road interior is split at any offset', function () {
  // The road is one 1 km span with no vertex between its ends, so every junction here is a genuine
  // split. The offsets are more than `joinToleranceM` (1.5 m) apart - two junctions a metre apart are
  // one place to `nodeAt` - and 196.5 / 203.5 straddle the 200 m bucket line.
  const offsetsM = [37, 196.5, 203.5, 613, 940];
  const edges = [{ id: 'road', coords: [
    { lat: REF_LAT, lon: REF_LON },
    { lat: REF_LAT, lon: REF_LON + 1000 / (111319.49 * Math.cos((REF_LAT * Math.PI) / 180)) }
  ] }];
  for (let i = 0; i < offsetsM.length; i++) {
    const m = offsetsM[i];
    const lon = REF_LON + m / (111319.49 * Math.cos((REF_LAT * Math.PI) / 180));
    edges.push({ id: 'side' + i, coords: [{ lat: REF_LAT, lon: lon }, { lat: REF_LAT + 80 / LAT_M, lon: lon }] });
  }
  const graph = street.buildGraph({ edges: edges });
  // A vertex exists on the road at every side-street foot, and the side street starts from it.
  for (let i = 0; i < offsetsM.length; i++) {
    const m = offsetsM[i];
    const wantLon = REF_LON + m / (111319.49 * Math.cos((REF_LAT * Math.PI) / 180));
    let footId = null;
    for (const node of graph.nodes.values()) {
      if (Math.abs(node.lat - REF_LAT) < 1e-9 && Math.abs(node.lon - wantLon) < 1e-6) footId = node.id;
    }
    assert.ok(footId !== null, 'no road vertex at ' + m + ' m');
    const sideNode = graph.nodes.get(footId);
    const sideEdges = (graph.adjacency.get(footId) || []).filter(function (entry) {
      const other = graph.nodes.get(entry.to);
      return other && other.lat > REF_LAT + 1e-6;
    });
    assert.strictEqual(sideEdges.length, 1, 'side street at ' + m + ' m is joined to the road vertex');
    assert.ok(sideNode && sideNode.lat === REF_LAT, 'the foot is on the centreline');
  }
  // Each side street also cuts the road, so the road is 1 + 5 spans even though it was drawn as one.
  const roadSpans = Array.from(graph.edges.values()).filter(function (edge) {
    const a = graph.nodes.get(edge.a);
    const b = graph.nodes.get(edge.b);
    return Math.abs(a.lat - REF_LAT) < 1e-9 && Math.abs(b.lat - REF_LAT) < 1e-9;
  });
  assert.strictEqual(roadSpans.length, 1 + offsetsM.length, 'road split at every side street');
});

done();
