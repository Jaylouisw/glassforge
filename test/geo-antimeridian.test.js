'use strict';
// The antimeridian is a join, not a wall. `geo.lonDelta` has said so since the street router was
// taught it (#236), but three helpers in the same module still subtract raw longitudes and so measure
// the long way round the planet: `centroid` (a demand list straddling 180° centred on 0°), `bbox`
// (a 0.2°-wide estate reported as a 359.8° box) and `pointAt` (the midpoint of such a route placed on
// the prime meridian). None of them had a test, which is why the fix that closed #236 could land
// beside them.
//
// The fixture is a Fiji/Chatham-shaped pair: lat -17.7, 0.2° of longitude either side of 180.
const { test, assert, close, done } = require('./harness');
const geo = require('../engine/geo');

const WEST = { lat: -17.7, lon: 179.9 };
const EAST = { lat: -17.7, lon: -179.9 };

// 0.2 deg of longitude on the parallel at -17.7: 2 * 6371008.8 * asin(sin(0.1 deg) * cos(17.7 deg))
// = 21186.25 m. `distanceM` is a great-circle formula and was always right; this locks it so a change
// to the helpers below cannot be "fixed" by moving the distance.
test('distance across the antimeridian is the short way, and it is 21.19 km', function () {
  close(geo.distanceM(WEST, EAST), 21186.25, 1, '0.2 deg at lat -17.7');
  close(geo.distanceM(EAST, WEST), 21186.25, 1, 'and symmetric');
});

// The centre of two points 21.19 km apart is 10.59 km from each of them, never 20000 km away at
// lon 0. Arithmetic mean of 179.9 and -179.9 is 0, which is the bug.
test('a demand centroid that straddles 180 sits on the meridian, not on lon 0', function () {
  const c = geo.centroid([WEST, EAST]);
  assert.ok(c, 'a centroid');
  close(c.lat, -17.7, 1e-9, 'lat is the mean');
  close(Math.abs(c.lon), 180, 1e-9, 'lon is +/-180 ("' + c.lon + '")');
  close(geo.distanceM(c, WEST), 21186.25 / 2, 1, 'half the span to the west point');
  close(geo.distanceM(c, EAST), 21186.25 / 2, 1, 'half the span to the east point');
});

test('a centroid of ordinary points is still the arithmetic mean', function () {
  // (-0.1 + -0.12) / 2 = -0.11; (51.5 + 51.6) / 2 = 51.55
  const c = geo.centroid([{ lat: 51.5, lon: -0.1 }, { lat: 51.6, lon: -0.12 }]);
  close(c.lat, 51.55, 1e-9, 'lat mean');
  close(c.lon, -0.11, 1e-9, 'lon mean');
});

test('a centroid of one point is that point', function () {
  const c = geo.centroid([WEST]);
  assert.deepStrictEqual(c, { lat: -17.7, lon: 179.9 });
});

// A box 0.2 deg wide must say so. `minLon > maxLon` is the crossing convention: the box runs east
// from minLon through 180 and on to maxLon. Reported as a plain min/max it was 359.8 deg wide - an
// estate in Fiji described as covering the entire planet.
test('a bbox that straddles 180 crosses it instead of spanning 359.8 deg', function () {
  const b = geo.bbox([WEST, EAST]);
  assert.strictEqual(b.minLon, 179.9, 'minLon');
  assert.strictEqual(b.maxLon, -179.9, 'maxLon');
  assert.ok(b.minLon > b.maxLon, 'minLon > maxLon is how a crossing box says so');
  // The width measured the short way is 0.2 deg: 179.9 -> -179.9 across 180.
  close(geo.lonDelta(b.minLon, b.maxLon), 0.2, 1e-9, 'width of the covered arc');
  close(b.minLat, -17.7, 1e-12, 'minLat');
  close(b.maxLat, -17.7, 1e-12, 'maxLat');
});

test('a bbox of ordinary points is unchanged', function () {
  // The same fixture and figures `test/demand-input.test.js` asserts on the API's summary.
  const b = geo.bbox([{ lat: 51.5, lon: -0.1 }, { lat: 51.5005, lon: -0.08 }]);
  assert.strictEqual(b.minLat, 51.5);
  assert.strictEqual(b.maxLat, 51.5005);
  assert.strictEqual(b.minLon, -0.1);
  assert.strictEqual(b.maxLon, -0.08);
});

test('pointAt walks a route across 180 the short way', function () {
  const mid = geo.pointAt([WEST, EAST], 0.5);
  close(Math.abs(mid.lon), 180, 1e-9, 'the midpoint is on the meridian ("' + mid.lon + '")');
  close(geo.distanceM(mid, WEST), 21186.25 / 2, 1, 'half way from the west point');
  const quarter = geo.pointAt([WEST, EAST], 0.25);
  // 179.9 + 0.25 * 0.2 = 179.95, still east of the meridian
  close(quarter.lon, 179.95, 1e-9, 'a quarter of the way');
  close(quarter.lat, -17.7, 1e-9, 'lat is unchanged on a parallel route');
});

test('pointAt on an ordinary route is still linear interpolation', function () {
  const p = geo.pointAt([{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }], 0.25);
  close(p.lon, 2.5, 1e-12, 'a quarter of 10 deg');
  close(p.lat, 0, 1e-12, 'lat');
});

// End to end through the module that publishes it: the demand summary is what `/api/import/demand`
// answers, so a Fiji list has to come back as a Fiji box, not a planetary one.
test('a demand list either side of 180 reports the crossing box', function () {
  const demand = require('../engine/demand');
  const rows = [{ label: 'West', lat: -17.7, lon: 179.9 }, { label: 'East', lat: -17.7, lon: -179.9 }];
  const parsed = demand.prepare(rows, {});
  assert.strictEqual(parsed.points.length, 2, 'both rows parsed');
  const b = parsed.bbox;
  assert.ok(b.minLon > b.maxLon, 'the box crosses: minLon "' + b.minLon + '", maxLon "' + b.maxLon + '"');
  close(geo.lonDelta(b.minLon, b.maxLon), 0.2, 1e-9, 'a 0.2 deg box');
  close(geo.distanceM(parsed.centre, WEST), 21186.25 / 2, 1, 'and a centre between the two houses');
});

done();
