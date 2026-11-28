'use strict';
// `lat` and `lon` are one placement. `network.validate` used to check each on its own, where `null`
// legitimately means "not on a map yet" - so a node stored with a latitude and no longitude passed,
// and `web/scene.js` drew it at the centre of the canvas (`placed: false`) instead of its street.
// Measured on main at 90d88f1, through `project.apply` then `network.validate` and `scene.project`:
//
//   { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', lat: 51.5, lng: -0.1 } }
//     stored    { lat: 51.5, lon: null }   validate ok: true, errors []
//     scene     { x: 400, y: 240, placed: false }        // the centre of an 800x480 canvas
//
// `lng` is the key every map library but GeoJSON uses, and `engine/demand.js` already reads it on an
// imported demand list, so the edit names it rather than dropping the longitude. A node with neither
// coordinate is still the legitimate unplaced state, and a node with both is still placed.
const { test, assert, done } = require('./harness');
const engine = require('../engine');
const scene = require('../web/scene');

const registry = engine.createRegistry();
const NOW = '2026-01-01T00:00:00.000Z';

function empty() {
  return engine.project.createProject('Coordinates', { id: 'pcoord', now: NOW });
}

function add(node) {
  return engine.project.apply(empty(), { op: 'add-node', node: node }, { now: NOW });
}

test('an add-node with lat and lng is refused, naming lng and the field it meant', function () {
  const applied = add({ type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lng: -0.1 });
  assert.ok(applied.error, 'the lng edit was accepted, so the OLT is stored without a longitude');
  assert.ok(applied.error.indexOf('lng') !== -1, applied.error);
  assert.ok(applied.error.indexOf('did you mean "lon"') !== -1, applied.error);
});

test('an add-node with one coordinate is refused, naming the half that is missing', function () {
  const noLon = add({ type: 'ont', model: 'gpon-ont-1ge', lat: 51.5 });
  assert.ok(noLon.error, 'a node with a latitude and no longitude was stored');
  assert.ok(noLon.error.indexOf('a latitude and no longitude') !== -1, noLon.error);
  const noLat = add({ type: 'ont', model: 'gpon-ont-1ge', lon: -0.1 });
  assert.ok(noLat.error, 'a node with a longitude and no latitude was stored');
  assert.ok(noLat.error.indexOf('a longitude and no latitude') !== -1, noLat.error);
});

test('a coordinate that is not a number in range is refused at the edit, not on the next GET', function () {
  const text = add({ type: 'olt', model: 'gpon-c-plus-8', lat: '51.5', lon: -0.1 });
  assert.ok(text.error, 'a coordinate sent as text was stored');
  assert.ok(text.error.indexOf('node.lat must be a number') !== -1, text.error);
  const north = add({ type: 'olt', model: 'gpon-c-plus-8', lat: 91, lon: -0.1 });
  assert.ok(north.error, 'a latitude of 91 was stored');
  assert.ok(north.error.indexOf('-90 and 90') !== -1, north.error);
});

test('a node with neither coordinate is still the legitimate "not placed yet" state', function () {
  // The control for the refusals above: the palette adds a node before anybody clicks the map, and
  // `null` on both is that state - not an error, and the canvas says so with `placed: false`.
  const applied = add({ type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' });
  assert.ok(!applied.error, applied.error);
  const stored = applied.project.nodes[0];
  assert.strictEqual(stored.lat, null);
  assert.strictEqual(stored.lon, null);
  assert.strictEqual(engine.network.validate(applied.project, registry).errors.length, 0);
  assert.strictEqual(scene.project(applied.project.nodes, { width: 800, height: 480 }).nodes[0].placed, false);
});

test('a node with both coordinates is placed and validates', function () {
  const applied = add({ type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lon: -0.1 });
  assert.ok(!applied.error, applied.error);
  const node = applied.project.nodes[0];
  assert.strictEqual(node.lat, 51.5);
  assert.strictEqual(node.lon, -0.1);
  assert.strictEqual(engine.network.validate(applied.project, registry).errors.length, 0);
  assert.strictEqual(scene.project(applied.project.nodes, { width: 800, height: 480 }).nodes[0].placed, true);
});

test('an update-node that sets one axis of an unplaced node is refused; both nulls unplace it', function () {
  const placed = add({ type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lon: -0.1 }).project;
  const half = engine.project.apply(placed, { op: 'update-node', id: 'n1', patch: { lat: 52 } }, { now: NOW });
  // 52 and -0.1 is a valid pair, so this one is a move along one axis and is allowed.
  assert.ok(!half.error, half.error);
  const unplaced = engine.project.apply(placed, { op: 'update-node', id: 'n1', patch: { lat: null, lon: null } }, { now: NOW });
  assert.ok(!unplaced.error, unplaced.error);
  const lone = engine.project.apply(unplaced.project, { op: 'update-node', id: 'n1', patch: { lon: -0.1 } }, { now: NOW });
  assert.ok(lone.error, 'a longitude patched onto an unplaced node was stored');
  assert.ok(lone.error.indexOf('a longitude and no latitude') !== -1, lone.error);
  const lng = engine.project.apply(placed, { op: 'update-node', id: 'n1', patch: { lng: -0.2 } }, { now: NOW });
  assert.ok(lng.error, 'a lng patch was accepted and moved nothing');
  assert.ok(lng.error.indexOf('did you mean "lon"') !== -1, lng.error);
});

test('a move-node out of range is refused at the edit', function () {
  const placed = add({ type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lon: -0.1 }).project;
  const north = engine.project.apply(placed, { op: 'move-node', id: 'n1', lat: 95, lon: -0.1 }, { now: NOW });
  assert.ok(north.error, 'a move to latitude 95 was stored');
  assert.ok(north.error.indexOf('-90 and 90') !== -1, north.error);
  const moved = engine.project.apply(placed, { op: 'move-node', id: 'n1', lat: 51.51, lon: -0.11 }, { now: NOW });
  assert.ok(!moved.error, moved.error);
  assert.strictEqual(moved.project.nodes[0].lat, 51.51);
});

test('validate names half a pair in a stored or PUT plant, and accepts two nulls', function () {
  // The write gate is `validate` - a hand-edited file and a `PUT` body come through here, not through
  // `apply`, so the rule has to hold on the plant itself.
  const half = {
    name: 'Half a pair',
    nodes: [{ id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lon: null }],
    spans: []
  };
  const verdict = engine.network.validate(half, registry);
  assert.strictEqual(verdict.ok, false, 'a node with a latitude and no longitude validated as ok');
  assert.ok(verdict.errors.some(function (e) { return e.indexOf('"n1"') !== -1 && e.indexOf('a latitude and no longitude') !== -1; }),
    JSON.stringify(verdict.errors));
  const unplaced = {
    name: 'Not placed yet',
    nodes: [{ id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: null, lon: null }],
    spans: []
  };
  const ok = engine.network.validate(unplaced, registry);
  assert.strictEqual(ok.errors.length, 0, JSON.stringify(ok.errors));
});

test('a legacy half is still renameable, and one patch of the missing coordinate fixes it', function () {
  // A project saved before this rule can carry half a pair. `update-node` must not lock it: a patch
  // that touches no coordinate is not a placement, so the name still edits, and the coordinate patch
  // is the repair. `validate` is where the legacy half is named in the meantime.
  const legacy = {
    id: 'plegacy', name: 'Legacy', createdAt: NOW, updatedAt: NOW, version: 1, history: [],
    nodes: [{ id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lon: null }],
    spans: []
  };
  assert.strictEqual(engine.network.validate(legacy, registry).ok, false);
  const renamed = engine.project.apply(legacy, { op: 'update-node', id: 'n1', patch: { name: 'OLT-Central' } }, { now: NOW });
  assert.ok(!renamed.error, renamed.error);
  const fixed = engine.project.apply(legacy, { op: 'update-node', id: 'n1', patch: { lon: -0.1 } }, { now: NOW });
  assert.ok(!fixed.error, fixed.error);
  assert.strictEqual(fixed.project.nodes[0].lon, -0.1);
  assert.strictEqual(engine.network.validate(fixed.project, registry).errors.length, 0);
});

done();
