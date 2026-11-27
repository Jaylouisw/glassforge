'use strict';
// The same duct drawn twice is one duct.
//
// A KMZ arrives with a road drawn whole and again as its two halves (Google Earth writes it that way,
// and so do two people editing one file). Planarising the whole line at the shared vertex splits it
// into exactly the two halves that are already there, so the graph carries the same trench two or
// three times over. Routing does not care - every copy has the same length - but the protected-pair
// search does: Suurballe may put one leg on each copy, and the answer is `disjoint: true, sharedM: 0`
// for two legs that are the *identical route*, which is the one number a site-to-site link report
// exists to get right.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const street = engine.street;

const A = { lat: 51.5, lon: -0.1 };
const B = { lat: 51.5, lon: -0.09 };
const MID = { lat: 51.5, lon: -0.095 };
const NORTH = { lat: 51.51, lon: -0.095 };

function graphOf(lines) {
  return street.buildGraph({ edges: lines }, { joinToleranceM: 5 });
}

function nodesAt(graph, point) {
  return Array.from(graph.nodes.values()).filter(function (n) {
    return Math.abs(n.lat - point.lat) < 1e-9 && Math.abs(n.lon - point.lon) < 1e-9;
  })[0];
}

/** Every pair of edges between the same two nodes, compared on their drawn geometry. */
function parallelPairs(graph) {
  const pairs = [];
  const edges = Array.from(graph.edges.values());
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i];
      const b = edges[j];
      const same = (a.a === b.a && a.b === b.b) || (a.a === b.b && a.b === b.a);
      if (!same) continue;
      const sameShape = a.geometry.length === b.geometry.length &&
        a.geometry.every(function (p, k) {
          const q = b.geometry[k];
          return Math.abs(p.lat - q.lat) < 1e-6 && Math.abs(p.lon - q.lon) < 1e-6;
        });
      pairs.push({ a: a.id, b: b.id, sameShape: sameShape });
    }
  }
  return pairs;
}

test('a line drawn whole and again as its halves leaves one edge per duct', function () {
  const graph = graphOf([
    { id: 'whole', coords: [A, B] },
    { id: 'half1', coords: [A, MID] },
    { id: 'half2', coords: [MID, B] }
  ]);
  // A - MID - B is two ducts; the whole line is those two, and the copies must not double them.
  assert.strictEqual(graph.edges.size, 2, 'edges: ' + Array.from(graph.edges.values()).map(function (e) { return e.id; }).join(','));
  const twins = parallelPairs(graph).filter(function (p) { return p.sameShape; });
  assert.strictEqual(twins.length, 0, 'duplicate drawings: ' + JSON.stringify(twins));
});

test('diversity is not faked by a second copy of the same trench', function () {
  // The straight duct drawn whole and again as its halves, and one genuine alternative that leaves A
  // and rejoins B without touching it: A -> N1 -> NORTH -> N2 -> B.
  const N1 = { lat: 51.51, lon: -0.1 };
  const N2 = { lat: 51.51, lon: -0.09 };
  const graph = graphOf([
    { id: 'whole', coords: [A, B] },
    { id: 'half1', coords: [A, MID] },
    { id: 'half2', coords: [MID, B] },
    { id: 'north-up', coords: [A, N1, NORTH] },
    { id: 'north-down', coords: [NORTH, N2, B] }
  ]);
  const out = street.diversePaths(graph, nodesAt(graph, A).id, nodesAt(graph, B).id);
  assert.strictEqual(out.legs.length, 2, 'the two legs of a protected pair');
  // The direct route is 0.0100 deg of longitude at 51.5 = 2 x 346.1 = 692.2 m. The north route is
  // 0.0100 deg of latitude (1111.9 m) + 0.0050 deg of longitude (346.1 m), twice = 2916.0 m. Taken
  // one on each copy of the straight duct the pair would total 1384.4 m, on two trenches that are
  // the same trench.
  const lengths = out.legs.map(function (l) { return l.lengthM; }).sort(function (x, y) { return x - y; });
  close(lengths[0], 692.2, 1.5, 'the direct leg');
  close(lengths[1], 2916.0, 3, 'the leg round the north');
  assert.strictEqual(out.disjoint, true);
  assert.strictEqual(out.sharedM, 0);
});

test('a duct with no alternative is not two legs of the same trench', function () {
  const graph = graphOf([
    { id: 'whole', coords: [A, B] },
    { id: 'half1', coords: [A, MID] },
    { id: 'half2', coords: [MID, B] }
  ]);
  const out = street.diversePaths(graph, nodesAt(graph, A).id, nodesAt(graph, B).id);
  // One duct exists, so there is no disjoint pair: the honest answer is two legs that share every
  // metre (692.2 = 2 x 346.1) or a single route - never `disjoint: true` with `sharedM: 0` on it.
  assert.strictEqual(out.disjoint, false, 'one trench is not two');
  close(out.sharedM, 692.2, 1.5, 'shared metres on the only route');
  for (const leg of out.legs) close(leg.lengthM, 692.2, 1.5, 'a leg on the only route');
});

test('two alignments between the same two junctions are still two ducts', function () {
  // A ring road: the two lines meet at A and B and nowhere between, but they are different drawings
  // and therefore different ducts. Collapsing those would hide real diversity.
  const EAST = { lat: 51.501, lon: -0.095 };
  const WEST = { lat: 51.499, lon: -0.095 };
  const graph = graphOf([
    { id: 'east', coords: [A, EAST, B] },
    { id: 'west', coords: [A, WEST, B] }
  ]);
  assert.strictEqual(graph.edges.size, 4, 'each alignment keeps its two edges: A-E, E-B, A-W, W-B');
  const out = street.diversePaths(graph, nodesAt(graph, A).id, nodesAt(graph, B).id);
  assert.strictEqual(out.disjoint, true);
  assert.strictEqual(out.sharedM, 0);
  assert.strictEqual(out.legs.length, 2);
});

done();
