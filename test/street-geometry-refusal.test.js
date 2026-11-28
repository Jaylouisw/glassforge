'use strict';
// An imported polyline this engine cannot read is refused by name, not shortened or dropped.
//
// `normaliseLine` used to filter the coordinates it could read and keep the rest of the line. On
// `main` before this suite, a three-point street of two 692.6 m legs whose MIDDLE vertex carried a
// blank longitude (a blank spreadsheet cell) imported as ONE straight 692.2 m edge - 693 m of street
// gone, and the middle vertex was no node, so a property beside it was refused as "not on the street
// network": the wrong name for a geometry fault the importer had already seen. A line whose every
// vertex was unreadable vanished the same way and the import still answered `edges: 1`, so nothing in
// the answer said a road was missing (gh#195).
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');
const street = engine.street;

// 0.001 deg of longitude at 51.5 N = 0.001 x 111319.49 x cos(51.5) = 69.26 m per step.
const WEST = { lat: 51.5, lon: -0.1010 };
const MID = { lat: 51.5, lon: -0.1000 };
const EAST = { lat: 51.5, lon: -0.0990 };

test('a vertex that is not a coordinate is refused, naming the edge and the point', function () {
  const err = throws(function () {
    street.buildGraph({ edges: [{ id: 'main', coords: [WEST, MID, { lat: 51.5, lon: '' }] }] });
  }, 'network edge 1 of 1 "main" has a coordinate that is not { lat, lon } at point 3 of 3',
  'a blank lon in the last vertex');
  // The message says what the value was, so the cell to fix is identifiable in a 3-point line.
  assert.ok(err.message.indexOf('lon ""') !== -1, 'the refusal quotes the bad value: ' + err.message);
});

test('the same refusal covers a missing latitude in the middle of a line', function () {
  throws(function () {
    street.buildGraph({ edges: [{ coords: [WEST, { lat: null, lon: -0.1000 }, EAST] }] });
  }, 'at point 2 of 3', 'a null lat in the middle vertex');
});

test('a line with unreadable vertices is not silently dropped beside a good one', function () {
  // Before: this answered a graph of one edge (the good line) and said nothing about "junk".
  throws(function () {
    street.buildGraph({ edges: [
      { id: 'good', coords: [WEST, EAST] },
      { id: 'junk', coords: [{ lat: 95, lon: 0 }, { lat: null, lon: null }] }
    ] });
  }, 'network edge 2 of 2 "junk" has a coordinate that is not { lat, lon } at point 1 of 2',
  'an all-unreadable second line');
});

test('a line with one coordinate is refused by name, not skipped', function () {
  throws(function () {
    street.buildGraph({ edges: [{ id: 'good', coords: [WEST, EAST] }, { id: 'stub', coords: [MID] }] });
  }, 'network edge 2 of 2 "stub" has 1 coordinate', 'a one-point line');
});

test('an entry that is not a line at all is named, not skipped', function () {
  throws(function () {
    street.buildGraph({ edges: [{ id: 'good', coords: [WEST, EAST] }, {}] });
  }, 'network edge 2 of 2 has no coordinates', 'an edge object with no coords');
});

test('a readable network still imports, with its bends and its length', function () {
  const graph = street.buildGraph({ edges: [{ id: 'main', coords: [WEST, MID, EAST] }] });
  // WEST-MID 69.26 m + MID-EAST 69.26 m = 138.5 m through the middle vertex; a line that dropped the
  // bend would measure 138.5 m too (it is straight here), so the edge count is the real assertion.
  close(graph.stats().lengthM, 138.5, 0.5, 'a three-vertex street keeps its length');
  assert.strictEqual(graph.stats().edges, 2, 'the middle vertex is a node, so the line is two edges');
});

done();
