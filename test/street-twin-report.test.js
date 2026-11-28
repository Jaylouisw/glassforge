'use strict';
// A drawing imported twice is one duct (GH issue: an import that merges a duplicate drawing must say
// so). `Graph.addEdge` collapses a segment that is the *same drawing* as one already present - the
// whole road plus the halves Google Earth writes, or one export merged into another - because
// Suurballe would otherwise route one leg of a protected pair on each copy and report `disjoint:
// true, sharedM: 0` for two legs on the same alignment. That collapse used to be silent: the graph
// answered `edges` without saying how many of the caller's segments had gone into an edge that was
// already there, and the only way to notice was to count the input by hand.
//
// The field is the vocabulary the rest of the engine already uses for this: `demand.prepare` reports
// `duplicates` for the points it dropped, `kml.classify` reports `duplicates` for the lines it
// deduped. `stats()` now carries the same word for the same fact.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const street = engine.street;
const geo = engine.geo;

const A = { lat: 51.5, lon: -0.1010 };
const B = { lat: 51.5, lon: -0.1000 };
const C = { lat: 51.5, lon: -0.0990 };

test('a duct drawn whole plus its two halves is two edges and two duplicates', function () {
  const graph = street.buildGraph({ edges: [
    { id: 'whole', coords: [A, C] },
    { id: 'west', coords: [A, B] },
    { id: 'east', coords: [B, C] }
  ] });
  const stats = graph.stats();
  // The whole line is split at B (an interior vertex) and both halves are the drawing that is
  // already there, so the two splits collapse onto the two halves: 2 edges, 3 nodes.
  assert.strictEqual(stats.edges, 2, 'one trench, cut at the middle vertex: ' + JSON.stringify(stats));
  assert.strictEqual(stats.nodes, 3);
  assert.strictEqual(stats.duplicates, 2, 'both collapsed splits are reported, not silently dropped');
  // 0.001 deg of longitude at 51.5 is 111319.49 x cos(51.5) = 69.3 m, so A-C is 2 x 69.3 = 138.6 m
  // - the duplicate drawing must not add a metre to the network.
  close(stats.lengthM, 138.6, 0.5, 'the duplicate drawing adds no length');
});

test('two alignments a metre apart are two ducts, not a duplicate', function () {
  // TWIN_EPS_DEG is a centimetre: this is 0.000009 deg of latitude = 1.0 m, a second duct in its own
  // alignment, which is exactly the diversity a planner pays for. The endpoints are within the 1.5 m
  // join tolerance, so the two ducts share their junction nodes and nothing else.
  const graph = street.buildGraph({ edges: [
    { id: 'south', coords: [{ lat: 51.5, lon: -0.1010 }, { lat: 51.5, lon: -0.0990 }] },
    { id: 'north', coords: [{ lat: 51.500009, lon: -0.1010 }, { lat: 51.500009, lon: -0.0990 }] }
  ] });
  const stats = graph.stats();
  assert.strictEqual(stats.edges, 2, 'two ducts on two alignments stay two edges');
  assert.strictEqual(stats.nodes, 2, 'their ends are within the join tolerance, so they meet at two nodes');
  assert.strictEqual(stats.duplicates, 0, 'a parallel duct is not a duplicate drawing');
});

test('an ordinary import reports zero duplicates, so the field is always readable', function () {
  const graph = street.buildGraph({ edges: [
    { id: 'main', coords: [A, B] },
    { id: 'side', coords: [B, { lat: 51.5020, lon: -0.1000 }] }
  ] });
  const stats = graph.stats();
  assert.strictEqual(stats.duplicates, 0, 'nothing collapsed, and the count is a number rather than absent');
  assert.strictEqual(stats.edges, 2);
  // The count is the caller's only evidence: it must not be confused with the node count or the
  // edge count, which the fields beside it answer.
  assert.strictEqual(typeof stats.nodes, 'number');
  assert.strictEqual(typeof stats.lengthKm, 'number');
});

done();
