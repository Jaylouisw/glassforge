'use strict';
// The canvas projection, tested without a browser: a projection that stacks two nodes is a bug
// nobody catches in a screenshot review.
const { test, assert, close, done } = require('./harness');
const scene = require('../web/scene');

function nodes() {
  return [
    { id: 'n1', type: 'olt', lat: 51.5, lon: -0.1 },
    { id: 'n2', type: 'closure', lat: 51.501, lon: -0.1 },
    { id: 'n3', type: 'ont', lat: 51.501, lon: -0.0995 }
  ];
}

test('nodes project inside the canvas with a margin', function () {
  const result = scene.project(nodes(), { width: 900, height: 560, pad: 40 });
  for (const node of result.nodes) {
    assert.ok(node.x >= 40 && node.x <= 860, node.id + ' x out of bounds: ' + node.x);
    assert.ok(node.y >= 40 && node.y <= 520, node.id + ' y out of bounds: ' + node.y);
  }
});

test('north is up: a higher latitude is a smaller y', function () {
  const result = scene.project(nodes(), { width: 900, height: 560 });
  const olt = result.nodes.find(function (n) { return n.id === 'n1'; });
  const nap = result.nodes.find(function (n) { return n.id === 'n2'; });
  assert.ok(nap.y < olt.y, 'the northern node should be drawn above the southern one');
});

test('the same geographic scale is used on both axes', function () {
  const result = scene.project(nodes(), { width: 900, height: 560, pad: 0 });
  const olt = result.nodes.find(function (n) { return n.id === 'n1'; });
  const nap = result.nodes.find(function (n) { return n.id === 'n2'; });
  const ont = result.nodes.find(function (n) { return n.id === 'n3'; });
  // n2 is 0.001 deg of latitude north of n1; n3 is 0.0005 deg of longitude east of n2.
  // At 51.5 deg, a degree of longitude is cos(51.5) = 0.6225 of a degree of latitude, so the
  // longitude step should be drawn 0.0005 * 0.6225 / 0.001 = 0.31 of the latitude step.
  const latStep = olt.y - nap.y;
  const lonStep = ont.x - nap.x;
  close(lonStep / latStep, 0.0005 * Math.cos((51.5005 * Math.PI) / 180) / 0.001, 0.02, 'axis scale ratio');
});

test('an unplaced node lands in the middle instead of at (0,0)', function () {
  const result = scene.project([{ id: 'n1', type: 'ont' }], { width: 900, height: 560 });
  assert.strictEqual(result.nodes[0].placed, false);
  assert.strictEqual(result.nodes[0].x, 450);
  assert.strictEqual(result.nodes[0].y, 280);
});

test('an empty project projects to nothing without throwing', function () {
  const result = scene.project([], {});
  assert.deepStrictEqual(result.nodes, []);
  assert.strictEqual(result.bounds, null);
});

test('unproject reverses project closely enough to place a node where the user clicked', function () {
  const projected = scene.project(nodes(), { width: 900, height: 560 });
  const olt = projected.nodes.find(function (n) { return n.id === 'n1'; });
  const back = scene.unproject(olt.x, olt.y, {
    width: 900, height: 560, scale: projected.scale, centre: projected.centre
  });
  close(back.lat, 51.5, 0.00005, 'latitude round trip');
  close(back.lon, -0.1, 0.00005, 'longitude round trip');
});

test('distance is great-circle, not flat-earth', function () {
  const d = scene.distanceM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
  assert.ok(d > 111000 && d < 111400, 'one degree of longitude at the equator is about 111.3 km, got ' + d);
  assert.strictEqual(Math.round(scene.distanceM({ lat: 10, lon: 10 }, { lat: 10, lon: 10 })), 0);
});
