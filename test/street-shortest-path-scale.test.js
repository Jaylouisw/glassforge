'use strict';
// The shortest-path search has to hold up on a street import, not just a drawing.
//
// `dijkstra` selected the next node by scanning *and re-sorting* every node id on every iteration -
// O(V^2 log V) for a question that is O(E log V). On a 100 x 100 grid (10,000 nodes, a 10 km town at
// 100 m spacing) that was 7,919 ms for one Dijkstra on this machine on 2026-11-28, and a real city
// import carries more vertices than the grid; `shortestArcs` had the same scan, once per augmentation
// of a protected-pair search. The numbers below are the contract: distances stay exact, ties still
// break on id, and the search finishes in the time a design run can wait for.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const street = engine.street;

const SPACING_M = 100;

/** A `n x n` grid of 100 m streets, built straight into the graph (no planarise: this suite is about
 * the search, and building 10,000 nodes through `buildGraph` would spend the budget on the import). */
function gridGraph(n) {
  const baseLat = 51.5;
  const baseLon = -0.1;
  const dLat = SPACING_M / 111132.95;
  const dLon = SPACING_M / (111319.49 * Math.cos(baseLat * Math.PI / 180));
  const graph = new street.Graph({});
  const at = [];
  for (let r = 0; r < n; r++) {
    at.push([]);
    for (let c = 0; c < n; c++) at[r].push(graph.nodeAt({ lat: baseLat + r * dLat, lon: baseLon + c * dLon }));
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const here = graph.nodes.get(at[r][c]);
      if (c + 1 < n) graph.addEdge(at[r][c], at[r][c + 1], [here, graph.nodes.get(at[r][c + 1])]);
      if (r + 1 < n) graph.addEdge(at[r][c], at[r + 1][c], [here, graph.nodes.get(at[r + 1][c])]);
    }
  }
  return { graph: graph, at: at };
}

test('a 10,000-node street grid is searched in the time a design run can wait for', function () {
  const built = gridGraph(100);
  assert.strictEqual(built.graph.nodes.size, 10000, 'the grid has 10,000 nodes');
  const root = built.at[0][0];
  const started = Date.now();
  const spt = street.dijkstra(built.graph, root);
  const elapsed = Date.now() - started;
  // Corner to corner on a 100 x 100 grid is 99 + 99 edges of 100 m. The grid is laid out in degrees
  // and measured by haversine, so the figure lands within 0.25% of the nominal metres.
  close(spt.dist.get(built.at[99][99]), 198 * SPACING_M, 198 * SPACING_M * 0.0025, 'corner-to-corner distance');
  assert.strictEqual(Array.from(spt.dist.values()).filter(function (d) { return isFinite(d); }).length,
    10000, 'every node in the grid is reachable');
  // The heap took 20 ms on this graph and the scan 6,022 ms in this suite's own run on 2026-11-28,
  // so the ceiling is a guard with two orders of magnitude of headroom, not a stopwatch: a runner
  // slow enough to trip it is one where the scan would have taken minutes.
  assert.ok(elapsed < 2500, 'one Dijkstra over 10,000 nodes took ' + elapsed + ' ms, over the 2,500 ms ceiling');
});

test('an equal-length tie still resolves on node id, so a re-run picks the same route', function () {
  // root - a - sink and root - b - sink, every edge 100 m: both paths are 200 m, and the search must
  // take the smaller id, exactly as the sorted full scan did.
  const graph = new street.Graph({});
  const root = graph.nodeAt({ lat: 51.5, lon: -0.1 });
  const a = graph.nodeAt({ lat: 51.5, lon: -0.099 });
  const b = graph.nodeAt({ lat: 51.5, lon: -0.101 });
  const sink = graph.nodeAt({ lat: 51.5005, lon: -0.1 });
  for (const pair of [[root, a], [root, b], [a, sink], [b, sink]]) {
    graph.addEdge(pair[0], pair[1], [graph.nodes.get(pair[0]), graph.nodes.get(pair[1])]);
  }
  assert.ok(a < b, 'node ids are generated in creation order, so "a" is the smaller id');
  const spt = street.dijkstra(graph, root);
  assert.strictEqual(spt.parent.get(sink).nodeId, a,
    'two equal paths must resolve to the smaller id (' + a + '), not ' + b);
  const first = street.routePath(graph, root, sink);
  const second = street.routePath(graph, root, sink);
  assert.deepStrictEqual(first.route, second.route, 'the same graph routes the same way twice');
});

test('a graph with no path to a node still reports it unreachable, not a zero', function () {
  const graph = new street.Graph({});
  const root = graph.nodeAt({ lat: 51.5, lon: -0.1 });
  const island = graph.nodeAt({ lat: 51.6, lon: -0.2 });
  graph.addEdge(root, graph.nodeAt({ lat: 51.5001, lon: -0.1 }), null);
  const spt = street.dijkstra(graph, root);
  assert.strictEqual(spt.dist.get(island), Infinity, 'an unconnected node stays at Infinity');
  assert.strictEqual(street.routePath(graph, root, island), null, 'and has no route');
});

done();
