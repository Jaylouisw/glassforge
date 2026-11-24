'use strict';
// The input side of auto-design: a list of addresses is a list of coordinates, or it is a refusal.
const { test, assert, throws, done } = require('./harness');
const demand = require('../engine/demand');

test('a CSV with a header is read by column name, not by position', function () {
  const csv = 'label,lon,address,lat\nCasa 30,-0.1010,Calle 3 #30,51.5010\nCasa 31,-0.1015,Calle 3 #31,51.5015\n';
  const parsed = demand.prepare(csv);
  assert.strictEqual(parsed.points.length, 2);
  assert.strictEqual(parsed.points[0].label, 'Casa 30');
  assert.strictEqual(parsed.points[0].lat, 51.501);
  assert.strictEqual(parsed.points[0].lon, -0.101);
  assert.strictEqual(parsed.points[0].address, 'Calle 3 #30');
});

test('semicolons, tabs and quoted fields all survive', function () {
  const semi = demand.prepare('name;lat;lon\nA;51.5;-0.1\n');
  assert.strictEqual(semi.points.length, 1);
  assert.strictEqual(semi.meta.delimiter, ';');
  assert.strictEqual(semi.points[0].label, 'A');

  const quoted = demand.prepare('label,lat,lon\n"12 High St, Flat 2",51.5,-0.1\n');
  assert.strictEqual(quoted.points[0].label, '12 High St, Flat 2');
});

test('a headerless file is assumed to be label,lat,lon and says so', function () {
  const parsed = demand.prepare('Casa 1,51.5,-0.1\nCasa 2,51.501,-0.1\n');
  assert.strictEqual(parsed.points.length, 2);
  assert.strictEqual(parsed.meta.assumedHeader, true);
});

test('a CSV with no coordinate columns is refused, naming what it found', function () {
  throws(function () { demand.prepare('address,postcode\nCalle 3,28001\n'); }, 'header naming a latitude');
});

test('bad rows are rejected with their row numbers, not dropped silently', function () {
  const csv = 'label,lat,lon\nGood,51.5,-0.1\nMissing,, -0.1\nOut of range,999,-0.1\nText,abc,def\n';
  const parsed = demand.prepare(csv);
  assert.strictEqual(parsed.points.length, 1);
  assert.strictEqual(parsed.rejected.length, 3);
  assert.deepStrictEqual(parsed.rejected.map(function (r) { return r.row; }), [3, 4, 5]);
});

test('duplicate coordinates are dropped and counted', function () {
  const parsed = demand.prepare([
    { label: 'a', lat: 51.5, lon: -0.1 },
    { label: 'b', lat: 51.5000001, lon: -0.1 },
    { label: 'c', lat: 51.502, lon: -0.1 }
  ]);
  assert.strictEqual(parsed.points.length, 2);
  assert.strictEqual(parsed.duplicates, 1);
});

test('an array of rows is accepted, with string numbers converted', function () {
  const parsed = demand.prepare([{ label: 'x', lat: '51.5', lon: '-0.1' }]);
  assert.strictEqual(parsed.points.length, 1);
  assert.strictEqual(parsed.points[0].lat, 51.5);
});

test('an empty coordinate in an array is rejected, not placed at 0,0', function () {
  // `Number('')` is 0, as is Number(null) and Number(' '), and 0,0 is a coordinate the range check
  // accepts. The CSV path tests the raw cell first; the array path converted first, so a blank cell
  // became a house in the Gulf of Guinea, several of them collapsed in `dedupe`, and no rejection
  // row was written. An array is what /api/import/demand and synthesise receive.
  const parsed = demand.prepare([
    { label: 'blank', lat: '', lon: '' },
    { label: 'null', lat: null, lon: null },
    { label: 'space', lat: ' ', lon: ' ' },
    { label: 'good', lat: '51.5', lon: '-0.1' }
  ]);
  assert.strictEqual(parsed.points.length, 1, 'only the real coordinate is a point');
  assert.strictEqual(parsed.points[0].label, 'good');
  assert.deepStrictEqual(parsed.rejected.map(function (r) { return r.row; }), [1, 2, 3]);
  assert.ok(/empty/.test(parsed.rejected[0].reason), parsed.rejected[0].reason);
  assert.strictEqual(parsed.duplicates, 0, 'a rejected row is not a duplicate');
});

test('a measured 0,0 given as numbers is still a coordinate', function () {
  // The guard against `Number('')` must not reject the equator: a numeric zero is a placed house,
  // and null/'' means "not placed yet" is a different state from a real 0.
  const parsed = demand.prepare([{ label: 'equator', lat: 0, lon: 0 }]);
  assert.strictEqual(parsed.points.length, 1);
  assert.strictEqual(parsed.points[0].lat, 0);
  assert.strictEqual(parsed.points[0].lon, 0);
  assert.strictEqual(parsed.rejected.length, 0);
});

test('a non-numeric array coordinate is rejected by name, not read as zero', function () {
  const parsed = demand.prepare([
    { label: 'a', lat: 'north', lon: '-0.1' },
    { label: 'b', lat: 51.5, lon: '-0.1' }
  ]);
  assert.strictEqual(parsed.points.length, 1);
  assert.strictEqual(parsed.rejected.length, 1);
  assert.strictEqual(parsed.rejected[0].row, 1);
  assert.ok(/not numbers/.test(parsed.rejected[0].reason), parsed.rejected[0].reason);
});

test('empty and unusable input is refused', function () {
  throws(function () { demand.prepare(''); }, 'empty');
  throws(function () { demand.prepare('lat,lon\n'); }, 'no usable demand points');
  const allSame = demand.prepare('label,lat,lon\nA,51.5,-0.1\nB,51.5,-0.1\n');
  assert.strictEqual(allSame.points.length, 1, 'two rows at one coordinate are one point');
  assert.strictEqual(allSame.duplicates, 1);
  throws(function () { demand.prepare(42); }, 'CSV string or an array');
});

test('ids are assigned in input order and the bbox covers the points', function () {
  const parsed = demand.prepare([
    { label: 'a', lat: 51.50, lon: -0.10 },
    { label: 'b', lat: 51.52, lon: -0.08 }
  ]);
  assert.deepStrictEqual(parsed.points.map(function (p) { return p.id; }), ['d1', 'd2']);
  assert.strictEqual(parsed.bbox.minLat, 51.5);
  assert.strictEqual(parsed.bbox.maxLon, -0.08);
});
