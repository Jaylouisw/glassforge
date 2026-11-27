'use strict';
// When no edge-disjoint pair exists, the second leg is "the path that shares the fewest metres"
// (engine/street.js, docs/AUTO-DESIGN.md, GLOSSARY.md). The search put a flat penalty on every
// shared arc, larger than the whole network, so what it really minimised was the *number* of shared
// arcs - and then, among equal counts, total length. On the graph below both alternates to the
// shortest path reuse two ducts: the shorter one reuses the 113 m diagonal and the approach
// (226.2 m), the 47 m longer one reuses the first feed and the approach (193.1 m). The report named
// the 226 m pair, overstating the shared duct of the circuit by 33 m - the number a planner signs
// off when they accept "diverse except N m". This suite pins the metres.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const street = engine.street;

// An 80 m grid at 51.5 N: node (i, j) is i steps north and j steps east of S.
const M_PER_DEG_LAT = 111132.95;
const M_PER_DEG_LON = 111319.49 * Math.cos(51.5 * Math.PI / 180);
function node(i, j) {
  return { lat: 51.5 + (i * 80) / M_PER_DEG_LAT, lon: -0.1 + (j * 80) / M_PER_DEG_LON };
}

const S = node(0, 0);
const A = node(0, 1);
const B = node(1, 0);
const J = node(1, 1);
const R1 = node(2, 0);
const R2 = node(2, 1);
const C3 = node(2, 2);
const T = node(3, 3);

// S feeds a junction J two ways; J reaches the far corner C3 by a 113 m diagonal and a ring
// B -> R1 -> R2 -> C3 runs under it. C3 -> T is the only approach to T, so every pair of routes
// shares it: no edge-disjoint pair exists and the fallback is the only path that can answer.
function network() {
  return street.buildGraph({ edges: [
    { id: 'feed-north', coords: [S, A] },
    { id: 'junction-north', coords: [A, J] },
    { id: 'feed-south', coords: [S, B] },
    { id: 'junction-south', coords: [B, J] },
    { id: 'diagonal', coords: [J, C3] },
    { id: 'ring-west', coords: [B, R1] },
    { id: 'ring-mid', coords: [R1, R2] },
    { id: 'ring-east', coords: [R2, C3] },
    { id: 'approach', coords: [C3, T] }
  ] }, { joinToleranceM: 5 });
}

function nodeIdAt(graph, point) {
  return Array.from(graph.nodes.values()).filter(function (n) {
    return Math.abs(n.lat - point.lat) < 1e-9 && Math.abs(n.lon - point.lon) < 1e-9;
  })[0].id;
}

function edgeBetween(graph, fromId, toId) {
  const found = Array.from(graph.edges.values()).filter(function (e) {
    return (e.a === fromId && e.b === toId) || (e.a === toId && e.b === fromId);
  });
  assert.strictEqual(found.length, 1, 'one duct between ' + fromId + ' and ' + toId);
  return found[0];
}

/** The edge ids along a chain of nodes, in order. */
function chain(graph, nodes) {
  const ids = [];
  for (let i = 1; i < nodes.length; i++) ids.push(edgeBetween(graph, nodes[i - 1], nodes[i]).id);
  return ids;
}

function metresOf(graph, edgeIds) {
  return edgeIds.reduce(function (n, id) { return n + graph.edges.get(id).lengthM; }, 0);
}

/** Metres of duct on both legs - the number diversity.sharedM reports. */
function sharedMetres(graph, a, b) {
  const onA = new Set(a);
  return b.filter(function (id) { return onA.has(id); })
    .reduce(function (n, id) { return n + graph.edges.get(id).lengthM; }, 0);
}

test('the fallback leg is the one that shares the fewest metres, not the fewest ducts', function () {
  const graph = network();
  const s = nodeIdAt(graph, S);
  const t = nodeIdAt(graph, T);

  // The shortest route, and the two alternates that exist beside it.
  const first = chain(graph, [s, nodeIdAt(graph, B), nodeIdAt(graph, J), nodeIdAt(graph, C3), t]);
  const viaNorth = chain(graph, [s, nodeIdAt(graph, A), nodeIdAt(graph, J), nodeIdAt(graph, C3), t]);
  const viaRing = chain(graph, [
    s, nodeIdAt(graph, B), nodeIdAt(graph, R1), nodeIdAt(graph, R2), nodeIdAt(graph, C3), t
  ]);

  const northShared = sharedMetres(graph, first, viaNorth);
  const ringShared = sharedMetres(graph, first, viaRing);
  // Both reuse two ducts; the ring is the longer leg but the less shared one.
  assert.ok(northShared > ringShared + 20,
    'fixture: the north feed must be the more shared alternate - ' + northShared.toFixed(2) +
    ' vs ' + ringShared.toFixed(2));
  assert.ok(metresOf(graph, viaRing) > metresOf(graph, viaNorth),
    'fixture: the fewest-shared-metres alternate must be the longer one');
  assert.ok(metresOf(graph, first) < metresOf(graph, viaNorth),
    'fixture: the first leg is the shortest route');

  const out = street.diversePaths(graph, s, t);
  assert.strictEqual(out.disjoint, false, 'the only approach to T is shared, so no pair is disjoint');
  assert.strictEqual(out.method, 'fewest-shared-metres');
  assert.strictEqual(out.legs.length, 2);

  // The report has to name the pair that shares least: 193.1 m, not the 226.2 m the shorter
  // alternate reuses. (This read 226.21 before the penalty was carried by the metre.)
  close(out.sharedM, ringShared, 0.05, 'shared metres: reported ' + out.sharedM +
    ', the north feed would share ' + northShared.toFixed(2));
  close(out.legs[1].lengthM, metresOf(graph, viaRing), 0.05, 'the longer, less shared leg is the second');

  // And the metres it names are the metres on both returned legs, not a figure of their own.
  const reported = sharedMetres(graph, out.legs[0].edges.map(function (e) { return e.edgeId; }),
    out.legs[1].edges.map(function (e) { return e.edgeId; }));
  close(reported, out.sharedM, 0.05, 'sharedM against the legs it came from');
});

test('the shared segments named are the ones both legs really use', function () {
  const graph = network();
  const s = nodeIdAt(graph, S);
  const t = nodeIdAt(graph, T);
  const out = street.diversePaths(graph, s, t);
  const ring = chain(graph, [
    s, nodeIdAt(graph, B), nodeIdAt(graph, R1), nodeIdAt(graph, R2), nodeIdAt(graph, C3), t
  ]);
  const first = chain(graph, [s, nodeIdAt(graph, B), nodeIdAt(graph, J), nodeIdAt(graph, C3), t]);
  const expected = first.filter(function (id) { return ring.indexOf(id) !== -1; }).sort();
  const named = out.shared.map(function (seg) { return seg.edgeId; }).sort();
  assert.deepStrictEqual(named, expected, 'shared segments: ' + named.join(',') +
    ' - expected ' + expected.join(','));
  close(out.shared.reduce(function (n, seg) { return n + seg.lengthM; }, 0), out.sharedM, 0.05,
    'the segments add up to sharedM');
});

done();
