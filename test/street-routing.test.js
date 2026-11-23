'use strict';
// Street routing: the graph, the snap, the routed tree, and the design that comes out of it.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');
const street = engine.street;
const geo = engine.geo;

const registry = engine.createRegistry();

// A T-shaped network: a main street east-west at 51.5000, and a side street running north from the
// junction at -0.1000. A property at -0.0998 / 51.5012 is 14 m east of the side street.
function network() {
  const main = [];
  for (let i = 0; i <= 10; i++) main.push({ lat: 51.5, lon: -0.1010 + i * 0.0002 });
  const side = [];
  for (let i = 0; i <= 10; i++) side.push({ lat: 51.5 + i * 0.0002, lon: -0.1000 });
  return { edges: [{ id: 'main', coords: main }, { id: 'side', coords: side }] };
}

const HEAD_END = { lat: 51.5, lon: -0.1010, name: 'PoP' };

test('polylines become a graph of nodes and edges with real lengths', function () {
  const graph = street.buildGraph(network());
  const stats = graph.stats();
  // main: 10 x 0.0002 deg of longitude at 51.5 = 10 x 13.9 m; side: 10 x 22.3 m of latitude
  close(stats.lengthM, 10 * 13.918 + 10 * 22.264, 3, 'network length');
  assert.ok(stats.nodes >= 11);
  assert.ok(stats.edges >= 20);
  const mainEdge = graph.edges.get('e1');
  assert.ok(mainEdge.lengthM > 13 && mainEdge.lengthM < 15);
});

test('KML LineStrings are accepted as a street network', function () {
  const kml = '<?xml version="1.0"?><kml><Document>' +
    '<Placemark><name>Main</name><LineString><coordinates>-0.1010,51.5,0 -0.0990,51.5,0</coordinates></LineString></Placemark>' +
    '<Placemark><name>Side</name><LineString><coordinates>-0.1000,51.5,0 -0.1000,51.5020,0</coordinates></LineString></Placemark>' +
    '</Document></kml>';
  const graph = street.buildGraph(kml);
  assert.ok(graph.stats().edges >= 2);
});

test('a KML with no lines is refused, and says what it found instead', function () {
  const kml = '<kml><Document><Placemark><name>box</name><Point><coordinates>-0.1,51.5,0</coordinates></Point></Placemark></Document></kml>';
  throws(function () { street.buildGraph(kml); }, 'no LineStrings');
  throws(function () { street.buildGraph({ edges: [] }); }, 'no usable polylines');
});

test('a property is snapped onto the street, and the gap is carried as a spur', function () {
  const graph = street.buildGraph(network());
  const onStreet = street.snap(graph, { lat: 51.5000, lon: -0.0995 });
  close(onStreet.spurM, 0, 0.5, 'a point on the street has no spur');

  const offStreet = street.snap(graph, { lat: 51.5012, lon: -0.0998 });
  const expected = geo.distanceM({ lat: 51.5012, lon: -0.0998 }, { lat: 51.5012, lon: -0.1000 });
  close(offStreet.spurM, expected, 0.5, 'the spur is the distance to the centreline');
  assert.ok(expected > 10 && expected < 18, 'about 14 m of gap, got ' + expected);
});

test('a property far from any street is unresolved, not connected by a straight line', function () {
  const graph = street.buildGraph(network());
  const far = street.snap(graph, { lat: 51.53, lon: -0.05 });
  assert.strictEqual(far, null);
  const tree = street.routedTree(graph, street.snap(graph, HEAD_END).nodeId, []);
  assert.deepStrictEqual(tree.unresolved, []);
});

test('a side street drawn from the middle of a main road is joined to it', function () {
  // The realistic case: the side street starts at a point on the main road where the main road has no
  // vertex. Merging only coincident vertices would leave two disconnected components and every house
  // on the side street would be "unreachable".
  const net = {
    edges: [
      { id: 'main', coords: [{ lat: 51.5, lon: -0.1010 }, { lat: 51.5, lon: -0.0990 }] },
      { id: 'side', coords: [{ lat: 51.5, lon: -0.1000 }, { lat: 51.5020, lon: -0.1000 }] }
    ]
  };
  const graph = street.buildGraph(net);
  const root = street.snap(graph, HEAD_END);
  const property = street.snap(graph, { lat: 51.5004, lon: -0.0998 });
  assert.ok(property, 'the property snaps to the side street');
  const path = street.routePath(graph, root.nodeId, property.nodeId);
  assert.ok(path, 'the side street is reachable from the main road');
  close(path.lengthM, 69.59 + 44.53, 5, 'main run then the first leg of the side street');
});

test('the routed run is longer than the straight line when the street detours', function () {
  const graph = street.buildGraph(network());
  const root = street.snap(graph, HEAD_END);
  const property = street.snap(graph, { lat: 51.5012, lon: -0.0998 });
  const path = street.routePath(graph, root.nodeId, property.nodeId);
  const straightM = geo.distanceM(HEAD_END, { lat: 51.5012, lon: -0.0998 });
  // ~70 m east along the main street, ~133 m north up the side street, then the 14 m spur.
  assert.ok(path.lengthM > straightM, 'routed ' + path.lengthM + ' vs straight ' + straightM);
  close(path.lengthM, 69.59 + 133.58, 6, 'routed length along two streets');
  assert.ok(path.route.length >= 3, 'the route keeps the bend');
  close(property.spurM, 13.9, 1, 'drop from the side street');
});

test('the routed tree is a tree: shared segments counted once, terminals per branch', function () {
  const graph = street.buildGraph(network());
  const root = street.snap(graph, HEAD_END).nodeId;
  const terminals = [
    { id: 'a', nodeId: street.snap(graph, { lat: 51.5004, lon: -0.0998 }).nodeId, spurM: 14 },
    { id: 'b', nodeId: street.snap(graph, { lat: 51.5008, lon: -0.0998 }).nodeId, spurM: 14 },
    { id: 'c', nodeId: street.snap(graph, { lat: 51.5012, lon: -0.0998 }).nodeId, spurM: 14 }
  ];
  const tree = street.routedTree(graph, root, terminals);
  assert.strictEqual(tree.unresolved.length, 0);
  const total = tree.edges.reduce(function (n, e) { return n + e.lengthM; }, 0);
  // Walked separately the three runs would be about 70+14, 70+36+14 and 70+80+14. As a tree they
  // share the 70 m of main street and the lower side street: 70 + 133 = ~203 m.
  assert.ok(total > 190 && total < 215, 'tree length ' + total);
  const branchCounts = tree.edges.map(function (e) { return e.terminals; }).sort();
  assert.ok(branchCounts.indexOf(3) !== -1, 'the trunk carries all three terminals: ' + branchCounts.join(','));
  // The root and the junction both carry all three terminals; nothing further up does.
  assert.strictEqual(tree.nodes.filter(function (n) { return n.terminals === 3; }).length, 2, 'root and junction');
  // One compressed trunk edge from the root to the first branch point, carrying all three.
  assert.strictEqual(tree.edges.filter(function (e) { return e.terminals === 3; }).length, 1, 'one trunk edge');
});

test('a design with a street network routes and says so', function () {
  const demand = [
    { label: 'A', lat: 51.5004, lon: -0.0998 },
    { label: 'B', lat: 51.5008, lon: -0.0998 },
    { label: 'C', lat: 51.5012, lon: -0.0998 }
  ];
  const straights = engine.design.synthesise(demand, { headEnd: HEAD_END }, registry);
  const routed = engine.design.synthesise(demand, { headEnd: HEAD_END, network: network() }, registry);

  assert.strictEqual(straights.routeMethod.indexOf('straight-line'), 0);
  assert.ok(routed.routeMethod.indexOf('street-graph') === 0, routed.routeMethod);
  assert.strictEqual(routed.ok, true, JSON.stringify(routed.notes));
  assert.ok(routed.best.metrics.cableM > straights.best.metrics.cableM,
    'routed ' + routed.best.metrics.cableM + ' should exceed straight-line ' + straights.best.metrics.cableM);

  const validation = engine.network.validate(routed.plant, registry);
  assert.deepStrictEqual(validation.errors, []);
  const budgets = engine.network.allOntBudgets(routed.plant, registry);
  for (const entry of budgets) assert.notStrictEqual(entry.result.verdict, 'fail', entry.ont);

  const routedSpans = routed.plant.spans.filter(function (s) { return s.route && s.route.length > 2; });
  assert.ok(routedSpans.length > 0, 'routed spans keep their street geometry');
  for (const run of routed.runs) {
    assert.strictEqual(run.method, routed.routeMethod);
    assert.ok(run.lengthM > 0);
  }
});

test('the ONT sits at the property and the drop is the real gap', function () {
  const out = engine.design.synthesise([{ label: 'A', lat: 51.5012, lon: -0.0998 }], {
    headEnd: HEAD_END,
    network: network(),
    technology: 'active'
  }, registry);
  assert.strictEqual(out.ok, true, JSON.stringify(out.notes));
  const drop = out.plant.spans.find(function (s) { return s.purpose === 'drop'; });
  assert.ok(drop, 'a drop span exists');
  close(drop.lengthM, 14, 1.5, 'drop length is the property-to-street gap');
});

test('an unreachable address makes every candidate infeasible, with the address named', function () {
  const out = engine.design.synthesise([
    { label: 'On street', lat: 51.5004, lon: -0.0998 },
    { label: 'Marooned', lat: 51.53, lon: -0.05 }
  ], { headEnd: HEAD_END, network: network() }, registry);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.plant, null);
  for (const candidate of out.candidates) {
    assert.strictEqual(candidate.feasible, false);
    assert.ok(candidate.reasons.join(' ').indexOf('not on the street network') !== -1, candidate.reasons.join(' | '));
    assert.ok(candidate.reasons.join(' ').indexOf('d2') !== -1, 'the address id is named: ' + candidate.reasons.join(' | '));
  }
});

test('routing is deterministic', function () {
  const demand = [
    { label: 'A', lat: 51.5004, lon: -0.0998 },
    { label: 'B', lat: 51.5008, lon: -0.1 },
    { label: 'C', lat: 51.5012, lon: -0.0998 }
  ];
  const a = engine.design.synthesise(demand, { headEnd: HEAD_END, network: network() }, registry);
  const b = engine.design.synthesise(demand, { headEnd: HEAD_END, network: network() }, registry);
  assert.strictEqual(JSON.stringify(a.plant), JSON.stringify(b.plant));
  assert.strictEqual(a.best.metrics.fibreMetres, b.best.metrics.fibreMetres);
});

test('a head-end off the network is refused rather than snapped from far away', function () {
  throws(function () {
    engine.design.synthesise([{ label: 'A', lat: 51.5004, lon: -0.0998 }], {
      headEnd: { lat: 51.53, lon: -0.05 },
      network: network()
    }, registry);
  }, 'more than');
});

test('two legs can be found on a ring, and a single corridor reports what it shares', function () {
  const ring = street.buildGraph({ edges: [
    { id: 'ab', coords: [{ lat: 51.5, lon: -0.1 }, { lat: 51.5, lon: -0.099 }] },
    { id: 'bc', coords: [{ lat: 51.5, lon: -0.099 }, { lat: 51.509, lon: -0.099 }] },
    { id: 'cd', coords: [{ lat: 51.509, lon: -0.099 }, { lat: 51.509, lon: -0.1 }] },
    { id: 'da', coords: [{ lat: 51.509, lon: -0.1 }, { lat: 51.5, lon: -0.1 }] }
  ] });
  const a = street.snap(ring, { lat: 51.5, lon: -0.1 }, { maxSnapM: 20 });
  const c = street.snap(ring, { lat: 51.509, lon: -0.099 }, { maxSnapM: 20 });
  const pair = street.diversePaths(ring, a.nodeId, c.nodeId);
  assert.strictEqual(pair.disjoint, true);
  assert.strictEqual(pair.sharedM, 0);
  assert.strictEqual(pair.legs.length, 2);
  const first = new Set(pair.legs[0].edges.map(function (e) { return e.edgeId; }));
  const second = new Set(pair.legs[1].edges.map(function (e) { return e.edgeId; }));
  for (const edgeId of first) assert.ok(!second.has(edgeId), edgeId + ' on both legs');

  // One duct, no alternative: the second "leg" is the same route, and the report says how much of it
  // is shared - 415.3 m of the 415.3 m, not "0 m, fully diverse".
  const corridor = street.buildGraph({ edges: [{ id: 'duct', coords: [{ lat: 51.5, lon: -0.1020 }, { lat: 51.5, lon: -0.0960 }] }] });
  const p = street.snap(corridor, { lat: 51.5, lon: -0.1020 }, { maxSnapM: 20 });
  const q = street.snap(corridor, { lat: 51.5, lon: -0.0960 }, { maxSnapM: 20 });
  const only = street.diversePaths(corridor, p.nodeId, q.nodeId);
  assert.strictEqual(only.disjoint, false);
  close(only.sharedM, only.legs[0].lengthM, 0.01, 'the whole corridor is shared');
  assert.strictEqual(only.shared.length, 1);
});
