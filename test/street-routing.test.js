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

// --- crossings between two lines -------------------------------------------------------------
// A T-junction has a vertex on a line. A crossing has none on either line, so the vertex merge finds
// nothing to do and the graph stays two components - which is every pair of roads drawn as separate
// polylines, and how most exported KML arrives. Two streets at grade meet, so the crossing is a node.

function crossingNet() {
  return { edges: [
    { id: 'main', coords: [{ lat: 51.5, lon: -0.1010 }, { lat: 51.5, lon: -0.0990 }] },
    { id: 'cross', coords: [{ lat: 51.49, lon: -0.1000 }, { lat: 51.51, lon: -0.1000 }] }
  ] };
}

test('two lines that cross between their vertices are joined where they cross', function () {
  const graph = street.buildGraph(crossingNet());
  // Each line is one edge; the crossing at -0.1000, 51.5000 cuts both in two, so 4 edges and
  // 4 ends + 1 junction = 5 nodes. 0.0010 deg of longitude at 51.5 = 69.3 m; 0.010 deg of latitude on
  // the crossing road = 1111.3 m either side.
  assert.strictEqual(graph.stats().edges, 4, 'both lines split at the crossing');
  assert.strictEqual(graph.stats().nodes, 5, 'four ends and one junction');

  const root = street.snap(graph, HEAD_END);
  const property = street.snap(graph, { lat: 51.5020, lon: -0.1000 });
  const path = street.routePath(graph, root.nodeId, property.nodeId);
  assert.ok(path, 'the crossing road is reachable from the main road');
  const crossing = { lat: 51.5, lon: -0.1000 };
  // 69.3 m along the main road + 222.3 m up the crossing road, measured from the same geometry.
  const expected = geo.distanceM(HEAD_END, crossing) + geo.distanceM(crossing, { lat: 51.5020, lon: -0.1000 });
  close(path.lengthM, expected, 1, 'the run is the two arms, with no detour to a distant junction');
});

test('splitting at a crossing adds a node, not a metre', function () {
  const graph = street.buildGraph(crossingNet());
  const total = Array.from(graph.edges.values()).reduce(function (n, e) { return n + e.lengthM; }, 0);
  const drawn = geo.distanceM({ lat: 51.5, lon: -0.1010 }, { lat: 51.5, lon: -0.0990 }) +
    geo.distanceM({ lat: 51.49, lon: -0.1000 }, { lat: 51.51, lon: -0.1000 });
  close(total, drawn, 0.5, 'the cable length is the geometry, cut in two');
});

test('the junction is found whatever order the two lines arrive in', function () {
  const net = crossingNet();
  const one = street.buildGraph({ edges: [net.edges[0], net.edges[1]] });
  const two = street.buildGraph({ edges: [net.edges[1], net.edges[0]] });
  assert.strictEqual(JSON.stringify(one.stats()), JSON.stringify(two.stats()));
  const at = street.snap(one, { lat: 51.5, lon: -0.1000 });
  close(at.spurM, 0, 0.1, 'a node sits on the crossing point');
  assert.strictEqual(one.adjacency.get(at.nodeId).length, 4, 'four arms meet there');
});

test('three lines through one point meet at one node, not three', function () {
  // A crossroads with a diagonal through it is still one junction: the crossing pass proposes three
  // points for the same place and `nodeAt` merges them within the join tolerance, so the graph gets
  // one node of degree 6 rather than three nodes of degree 4 stacked on top of each other.
  const graph = street.buildGraph({ edges: [
    { id: 'main', coords: [{ lat: 51.5, lon: -0.1010 }, { lat: 51.5, lon: -0.0990 }] },
    { id: 'cross', coords: [{ lat: 51.49, lon: -0.1000 }, { lat: 51.51, lon: -0.1000 }] },
    { id: 'diag', coords: [{ lat: 51.4955, lon: -0.1005 }, { lat: 51.5045, lon: -0.0995 }] }
  ] });
  assert.strictEqual(graph.stats().edges, 6, 'three lines, each cut in two');
  assert.strictEqual(graph.stats().nodes, 7, 'six ends and one junction');
  const at = street.snap(graph, { lat: 51.5, lon: -0.1000 });
  assert.strictEqual(graph.adjacency.get(at.nodeId).length, 6, 'six arms meet there');
});

test('two roads running 3 m apart are not joined by the crossing pass', function () {
  // 0.000027 deg of latitude = 3.0 m, twice the 1.5 m join tolerance: two parallel roads alongside
  // each other for 139 m. They never cross, so nothing may connect them - a graze is not a junction.
  const graph = street.buildGraph({ edges: [
    { id: 'north', coords: [{ lat: 51.5, lon: -0.1010 }, { lat: 51.5, lon: -0.0990 }] },
    { id: 'south', coords: [{ lat: 51.499973, lon: -0.1010 }, { lat: 51.499973, lon: -0.0990 }] }
  ] });
  assert.strictEqual(graph.stats().edges, 2);
  assert.strictEqual(graph.stats().nodes, 4);
  const a = street.snap(graph, { lat: 51.5, lon: -0.1010 });
  const b = street.snap(graph, { lat: 51.499973, lon: -0.0990 });
  assert.strictEqual(street.routePath(graph, a.nodeId, b.nodeId), null, 'two parallel roads do not connect');
});

test('a design can serve addresses on both sides of a crossing', function () {
  // The whole point of the junction: a head-end on one road, addresses on both, and no address
  // refused as "not on the street network" because the import never traced the crossing.
  const result = engine.design.synthesise(
    [{ label: 'A', lat: 51.5020, lon: -0.1000 }, { label: 'B', lat: 51.5, lon: -0.0995 }],
    { headEnd: HEAD_END, network: crossingNet() },
    registry
  );
  assert.strictEqual(result.ok, true, (result.rationale || []).join(' | '));
  assert.strictEqual(result.routeMethod.indexOf('street-graph'), 0, result.routeMethod);
  // The winner on this demand is a home-run, so each cable is measured from the head-end and the
  // 69.3 m main-road arm is bought twice - an active home-run has no trunk to share. What the crossing
  // buys is reachability: both totals are street geometry, and without the junction address A has no
  // route at all. 69.3 + 222.3 = 291.6 m, and 69.3 + 34.6 = 103.9 m (0.0005 deg of longitude at 51.5
  // is 34.6 m).
  const total = result.runs.reduce(function (n, run) { return n + run.lengthM; }, 0);
  close(total, 291.6 + 103.9, 1.5, 'both runs are routed: ' + result.runs.map(function (r) { return r.lengthM; }).join(' + '));
});

test('the junction sits where the lines cross, not halfway along either', function () {
  // This crossing is 75% along the main road and 50% along the side road. A symmetric X cannot tell
  // the two parameters apart; taking the wrong one put the junction at -0.099167 - 83 m east of the
  // real crossing - on the first implementation of this pass.
  const graph = street.buildGraph({ edges: [
    { id: 'main', coords: [{ lat: 51.5, lon: -0.1010 }, { lat: 51.5, lon: -0.0990 }] },
    { id: 'side', coords: [{ lat: 51.49, lon: -0.0995 }, { lat: 51.51, lon: -0.0995 }] }
  ] });
  const at = street.snap(graph, { lat: 51.5, lon: -0.0995 });
  close(at.spurM, 0, 0.1, 'the node is on the crossing point');
  assert.strictEqual(graph.adjacency.get(at.nodeId).length, 4, 'four arms meet there');
  const west = street.snap(graph, { lat: 51.5, lon: -0.1010 });
  const east = street.snap(graph, { lat: 51.5, lon: -0.0990 });
  // 0.0015 deg of longitude at 51.5 = 103.9 m of the 138.6 m road, and 0.0005 deg = 34.6 m of it.
  close(street.routePath(graph, west.nodeId, at.nodeId).lengthM, 103.83, 0.2, 'west arm');
  close(street.routePath(graph, east.nodeId, at.nodeId).lengthM, 34.61, 0.2, 'east arm');
});

test('a protected pair can be drawn round a ring whose four corners are only crossings', function () {
  // Four roads, each drawn past the other, so no corner is a vertex on either line: the ring exists
  // only because the crossings were turned into junctions. Without them there is no second leg, and
  // nothing for `diversePaths` to protect.
  const graph = street.buildGraph({ edges: [
    { id: 'north', coords: [{ lat: 51.505, lon: -0.1010 }, { lat: 51.505, lon: -0.0990 }] },
    { id: 'south', coords: [{ lat: 51.500, lon: -0.1010 }, { lat: 51.500, lon: -0.0990 }] },
    { id: 'west', coords: [{ lat: 51.4995, lon: -0.1000 }, { lat: 51.5055, lon: -0.1000 }] },
    { id: 'east', coords: [{ lat: 51.4995, lon: -0.0995 }, { lat: 51.5055, lon: -0.0995 }] }
  ] });
  assert.strictEqual(graph.stats().edges, 12, 'each road is cut twice');
  assert.strictEqual(graph.stats().nodes, 12, '8 ends and 4 corners');
  const a = street.snap(graph, { lat: 51.500, lon: -0.1000 });
  const b = street.snap(graph, { lat: 51.500, lon: -0.0995 });
  const pair = street.diversePaths(graph, a.nodeId, b.nodeId);
  assert.strictEqual(pair.disjoint, true, pair.method);
  assert.strictEqual(pair.sharedM, 0, JSON.stringify(pair.shared));
  assert.strictEqual(pair.legs.length, 2);
  // 34.6 m along the south road against 0.0005 deg of longitude plus 2 x 0.005 deg of latitude:
  // the direct leg is the short one.
  close(Math.min(pair.legs[0].lengthM, pair.legs[1].lengthM), 34.61, 0.2, 'the direct leg');
});
