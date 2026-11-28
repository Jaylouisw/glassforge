'use strict';
// A node is placed by `lat` and `lon`. `null` on both means "not placed on a map yet" - a legitimate
// state for a node added from the palette - but one axis of a pair is neither placed nor unplaced,
// and nothing used to name it. Measured on `main` at 90d88f1, through `project.apply` then
// `network.validate` and `web/scene.js`:
//
//   { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', lat: 51.5, lng: -0.1 } }
//     stored:   { lat: 51.5, lon: null }
//     validate: ok: true, errors: []
//     scene:    { x: 400, y: 240, placed: false }        // the centre of an 800x480 canvas
//
// `lng` is the spelling every map library but GeoJSON uses, and `engine/demand.js` already reads it
// off a demand list (`LON_NAMES`), so one tool accepted `lng` on an import and dropped it on an edit.
// The node answered 200, passed `validate`, and the plan drew its OLT in the middle of an arbitrary
// view. The same shape was reachable without a typo: `{ lat: 51.5 }` alone, `{ lon: -0.1 }` alone, or
// an `update-node` patch that sets one axis of an unplaced node.
const { test, assert, done } = require('./harness');
const engine = require('../engine');
const scene = require('../web/scene');

const registry = engine.createRegistry();

function fresh() {
  return engine.project.createProject('Placement', { id: 'p-place' });
}

function add(project, node) {
  return engine.project.apply(project, { op: 'add-node', node: node });
}

const OLT = { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' };

function place(overrides) {
  return add(fresh(), Object.assign({}, OLT, overrides));
}

const HALF_LAT = 'node "n1" has a latitude and no longitude - a placement is lat and lon together, or neither ' +
  '(null = not placed on a map yet)';
const HALF_LON = 'node "n1" has a longitude and no latitude - a placement is lat and lon together, or neither ' +
  '(null = not placed on a map yet)';

// ------------------------------------------------------------------ lng is the alias for lon
const withLng = place({ lat: 51.5, lng: -0.1 });
test('a node placed with lng is stored with that longitude, under the field the engine reads', function () {
  assert.ok(!withLng.error, withLng.error);
  const node = withLng.project.nodes[0];
  assert.strictEqual(node.lat, 51.5);
  // The coordinate the caller gave, not null: lon is the one field the projection and geo.js read.
  assert.strictEqual(node.lon, -0.1);
  // An alias at the write gate, not a second field on the model - nothing would read it later.
  assert.strictEqual(node.lng, undefined);
});

test('the stored node validates clean, so the edit is not a 200 that stores a fault', function () {
  const check = engine.network.validate(withLng.project, registry);
  assert.deepStrictEqual(check.errors, []);
  assert.strictEqual(check.ok, true);
});

const withBoth = place({ lat: 51.5, lon: -0.1, lng: -0.1 });
test('a caller that sends both spellings with the same value is accepted, not refused for pedantry', function () {
  assert.ok(!withBoth.error, withBoth.error);
  assert.strictEqual(withBoth.project.nodes[0].lon, -0.1);
});

const disagree = place({ lat: 51.5, lon: -0.1, lng: 0.4 });
test('two different longitudes in one request are refused, naming the node and both values', function () {
  assert.ok(disagree.error, 'expected a refusal, got a stored node at lon ' + (disagree.project && disagree.project.nodes[0].lon));
  assert.strictEqual(disagree.error,
    'node "n1" is given lon -0.1 and lng 0.4 - lon and lng are one field and the values disagree');
});

// ------------------------------------------------------------------ half a pair is refused
const latOnly = place({ lat: 51.5 });
test('a latitude with no longitude is refused, naming the node and the missing axis', function () {
  assert.ok(latOnly.error, 'expected a refusal, got ' + JSON.stringify(latOnly.project && latOnly.project.nodes[0]));
  assert.strictEqual(latOnly.error, HALF_LAT);
});

const lonOnly = place({ lon: -0.1 });
test('a longitude with no latitude is refused the same way', function () {
  assert.ok(lonOnly.error, 'expected a refusal, got ' + JSON.stringify(lonOnly.project && lonOnly.project.nodes[0]));
  assert.strictEqual(lonOnly.error, HALF_LON);
});

const unplaced = place({});
test('neither axis is still a legitimate unplaced node, so the palette still works', function () {
  assert.ok(!unplaced.error, unplaced.error);
  assert.strictEqual(unplaced.project.nodes[0].lat, null);
  assert.strictEqual(unplaced.project.nodes[0].lon, null);
});

// ------------------------------------------------------------------ update-node: the resulting node is what counts
const halfPatch = engine.project.apply(unplaced.project, {
  op: 'update-node', id: 'n1', patch: { lat: 51.5 }
});
test('an update-node patch that places one axis of an unplaced node is refused', function () {
  assert.ok(halfPatch.error, 'expected a refusal, got ' + JSON.stringify(halfPatch.project && halfPatch.project.nodes[0]));
  assert.strictEqual(halfPatch.error, HALF_LAT);
});

const placed = withBoth.project;
const latMoved = engine.project.apply(placed, { op: 'update-node', id: 'n1', patch: { lat: 51.6 } });
test('a patch that moves one axis of a placed node keeps the other axis and is a normal edit', function () {
  assert.ok(!latMoved.error, latMoved.error);
  assert.strictEqual(latMoved.project.nodes[0].lat, 51.6);
  assert.strictEqual(latMoved.project.nodes[0].lon, -0.1);
});

const halfCleared = engine.project.apply(placed, { op: 'update-node', id: 'n1', patch: { lon: null } });
test('a patch that nulls one axis of a placed node is refused, because it leaves half a placement', function () {
  assert.ok(halfCleared.error, 'expected a refusal, got ' + JSON.stringify(halfCleared.project && halfCleared.project.nodes[0]));
  assert.strictEqual(halfCleared.error, HALF_LAT);
});

const lngPatch = engine.project.apply(unplaced.project, {
  op: 'update-node', id: 'n1', patch: { lat: 51.5, lng: -0.1 }
});
test('update-node reads lng too, so a map library can save the pan it drew', function () {
  assert.ok(!lngPatch.error, lngPatch.error);
  assert.strictEqual(lngPatch.project.nodes[0].lon, -0.1);
  assert.strictEqual(lngPatch.project.nodes[0].lng, undefined);
});

const repaired = engine.project.apply(
  { id: 'p-place', name: 'Placement', createdAt: null, updatedAt: null, version: 1, history: [],
    nodes: [{ id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lon: null }],
    spans: [] },
  { op: 'update-node', id: 'n1', patch: { lon: -0.1 } }
);
test('the missing axis can be supplied, so a node stored half-placed by the old bug is repairable', function () {
  assert.ok(!repaired.error, repaired.error);
  assert.strictEqual(repaired.project.nodes[0].lat, 51.5);
  assert.strictEqual(repaired.project.nodes[0].lon, -0.1);
});

// ------------------------------------------------------------------ move-node
const moved = engine.project.apply(placed, { op: 'move-node', id: 'n1', lat: 51.7, lng: -0.2 });
test('move-node accepts lng for lon, the same alias as add-node', function () {
  assert.ok(!moved.error, moved.error);
  assert.strictEqual(moved.project.nodes[0].lat, 51.7);
  assert.strictEqual(moved.project.nodes[0].lon, -0.2);
});

const halfMove = engine.project.apply(placed, { op: 'move-node', id: 'n1', lat: 51.7 });
test('move-node with one axis is refused rather than moving half a node', function () {
  assert.ok(halfMove.error, 'expected a refusal, got ' + JSON.stringify(halfMove.project && halfMove.project.nodes[0]));
  assert.strictEqual(halfMove.error, 'move-node needs numeric lat and lon');
});

// ------------------------------------------------------------------ the drawing follows the coordinate
const estate = add(withLng.project, {
  id: 'n2', type: 'ont', model: 'gpon-ont-4ge', name: 'A', lat: 51.51, lon: -0.09
});
test('the canvas places both nodes, so the OLT is drawn where it was put', function () {
  assert.ok(!estate.error, estate.error);
  const drawing = scene.project(estate.project.nodes, { width: 800, height: 480 });
  assert.deepStrictEqual(drawing.nodes.map(function (n) { return n.placed; }), [true, true]);
  // 400,240 is the centre the old bug drew an unplaced node at.
  assert.notStrictEqual(drawing.nodes[0].x, 400);
  assert.notStrictEqual(drawing.nodes[0].y, 240);
  assert.notDeepStrictEqual(
    [drawing.nodes[0].x, drawing.nodes[0].y], [drawing.nodes[1].x, drawing.nodes[1].y]);
});

// ------------------------------------------------------------------ a hand-edited file is named by the validator
function handEdited(nodes) {
  const p = fresh();
  p.nodes = nodes;
  return engine.network.validate(p, registry);
}

test('a hand-edited node with half a placement is an error, not a clean save', function () {
  const check = handEdited([
    { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', lat: 51.5, lon: null }
  ]);
  assert.deepStrictEqual(check.errors, [HALF_LAT]);
});

test('a hand-edited node carrying lng is named by the spelling it used, not by a missing lon', function () {
  const check = handEdited([
    { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', lat: 51.5, lng: -0.1 }
  ]);
  assert.deepStrictEqual(check.errors, [
    'node "n1" has "lng" and no "lon" - a saved node is placed by lat and lon, and nothing reads lng'
  ]);
});

test('a node with neither axis stays a legitimate unplaced state', function () {
  const check = handEdited([
    { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', lat: null, lon: null }
  ]);
  assert.deepStrictEqual(check.errors, []);
});

test('an axis that is present but not a number is still the invalid-value error, not the half message', function () {
  const check = handEdited([
    { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', lat: '51.5', lon: null }
  ]);
  assert.deepStrictEqual(check.errors, ['node "n1" has an invalid latitude']);
});

done();
