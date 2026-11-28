'use strict';
// The canvas is a map, so the antimeridian is a join here too. `engine/geo.ts` learned that for
// `bbox`/`centroid`/`pointAt` (#249) and the street router before it (#236), but `web/scene.js`
// still subtracts longitudes raw: `bounds` reported a 0.15 deg estate as a 359.85 deg box, so the
// projection fitted the whole planet into 828 px and drew neighbouring houses 0.1 px apart.
//
// The fixture is the same Fiji/Chatham shape the geo suite uses: lat -17.7, a few hundredths of a
// degree either side of 180.
const { test, assert, close, done } = require('./harness');
const scene = require('../web/scene');

const OPTIONS = { width: 900, height: 560, pad: 36 };

// 179.90 -> 179.95 east of the meridian, then -179.95 west of it. The whole set spans 0.15 deg;
// `a` and `b` are 0.05 deg apart (5.3 km on the parallel at -17.7), a third of the span.
function crossing() {
  return [
    { id: 'a', type: 'olt', lat: -17.7, lon: 179.95 },
    { id: 'b', type: 'ont', lat: -17.7005, lon: 179.90 },
    { id: 'c', type: 'ont', lat: -17.7005, lon: -179.95 }
  ];
}

test('a bounds box that straddles 180 crosses it instead of spanning 359.85 deg', function () {
  const b = scene.bounds(crossing());
  assert.ok(b, 'a bounds box');
  assert.strictEqual(b.minLon, 179.9, 'minLon is the west end of the covered arc');
  assert.strictEqual(b.maxLon, -179.95, 'maxLon is the east end of it');
  assert.ok(b.minLon > b.maxLon, 'minLon > maxLon is how a crossing box says so');
  close(b.minLat, -17.7005, 1e-12, 'minLat is still a plain min');
  close(b.maxLat, -17.7, 1e-12, 'maxLat is still a plain max');
});

test('a bounds box of ordinary points is unchanged', function () {
  const b = scene.bounds([
    { id: 'n1', type: 'olt', lat: 51.5, lon: -0.1 },
    { id: 'n2', type: 'ont', lat: 51.501, lon: -0.0995 }
  ]);
  assert.strictEqual(b.minLon, -0.1);
  assert.strictEqual(b.maxLon, -0.0995);
});

test('two nodes 5.3 km apart either side of 179.9 are drawn kilometres apart, not on top of each other', function () {
  const result = scene.project(crossing(), OPTIONS);
  const a = result.nodes.find(function (n) { return n.id === 'a'; });
  const b = result.nodes.find(function (n) { return n.id === 'b'; });
  // 0.05 of a 0.15 deg span is a third of the 828 px inner width: 276 px.
  assert.ok(Math.abs(a.x - b.x) > 200, 'a and b are ' + Math.abs(a.x - b.x) + ' px apart');
  for (const node of result.nodes) {
    assert.ok(node.x >= 36 && node.x <= 864, node.id + ' x is off the canvas: ' + node.x);
  }
  // The centre of the drawing is the midpoint of the covered arc beside the plant: the box runs
  // 179.90 -> 180 -> -179.95, so its middle is 179.90 + 0.15 / 2 = 179.975, not lon 0 (20000 km away).
  close(result.centre.lon, 179.975, 1e-9, 'centre lon ("' + result.centre.lon + '")');
});

test('a routed span that crosses 180 stays where it belongs', function () {
  const result = scene.project(crossing(), OPTIONS);
  const transform = {
    width: OPTIONS.width, height: OPTIONS.height, scale: result.scale, centre: result.centre
  };
  const route = scene.projectPoints([
    { lat: -17.7, lon: 179.98 },
    { lat: -17.7, lon: 180 },
    { lat: -17.7, lon: -179.98 }
  ], transform);
  for (const point of route) {
    assert.ok(point.x >= 36 && point.x <= 864, 'route x is off the canvas: ' + point.x);
  }
  // The three points span 0.04 of the 0.15 deg view: 221 px. Raw subtraction put the middle one
  // 180 deg (half a planet) away from the ends.
  assert.ok(Math.abs(route[0].x - route[2].x) < 300, 'route span ' + Math.abs(route[0].x - route[2].x) + ' px');
  assert.ok(route[1].x > Math.min(route[0].x, route[2].x) && route[1].x < Math.max(route[0].x, route[2].x),
    'the 180 point is between its neighbours, at x ' + route[1].x);
});

test('unproject beside a crossing plant returns a longitude beside it, not a third of the way round', function () {
  const result = scene.project(crossing(), OPTIONS);
  const back = scene.unproject(OPTIONS.width / 2 + 100, OPTIONS.height / 2, {
    width: OPTIONS.width, height: OPTIONS.height, scale: result.scale, centre: result.centre
  });
  // A click 100 px east of centre is a small part of a 0.15 deg view, so it lands within a degree of
  // the meridian; the buggy centre of lon 0 put it at about 43 deg east.
  assert.ok(Math.abs(back.lon) > 179, 'unprojected lon ' + back.lon + ' is beside the plant');
});

done();
