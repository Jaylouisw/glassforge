'use strict';
// Import is how a planner gets a route somebody already surveyed, so the parser has to be honest
// about what it read and what it skipped.
const zlib = require('zlib');
const { test, assert, throws, close, done } = require('./harness');
const kml = require('../engine/kml');

const SAMPLE = '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Barrio Norte</name>' +
  '<Placemark><name>Feeder A</name><description><![CDATA[route along Calle 3]]></description>' +
  '<LineString><coordinates>-0.1000,51.5000,0 -0.1010,51.5000,0 -0.1010,51.5010,0</coordinates></LineString></Placemark>' +
  '<Placemark><name>NAP 12</name><Point><coordinates>-0.1010,51.5010,0</coordinates></Point></Placemark>' +
  '<Placemark><name>Parcel</name><Polygon><outerBoundaryIs><LinearRing>' +
  '<coordinates>-0.2,51.5 -0.21,51.5 -0.21,51.51 -0.2,51.5</coordinates>' +
  '</LinearRing></outerBoundaryIs></Polygon></Placemark>' +
  '<Placemark><name>Just a folder</name></Placemark>' +
  '</Document></kml>';

function storedZip(name, content) {
  const data = Buffer.from(content, 'utf8');
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);              // method 0: stored
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);           // method 0
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);           // local header offset
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(local.length + nameBuf.length + data.length, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

function deflatedZip(name, content) {
  const raw = Buffer.from(content, 'utf8');
  const data = zlib.deflateRawSync(raw);
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);              // method 8: deflate
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(local.length + nameBuf.length + data.length, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

test('KML geometry is read, including CDATA descriptions', function () {
  const parsed = kml.parseKml(SAMPLE);
  assert.strictEqual(parsed.name, 'Barrio Norte');
  assert.strictEqual(parsed.placemarks.length, 3, 'the folder-only placemark has no geometry');
  assert.strictEqual(parsed.unsupported, 1);
  const route = parsed.placemarks[0];
  assert.strictEqual(route.geometry.type, 'LineString');
  assert.strictEqual(route.geometry.coords.length, 3);
  assert.strictEqual(route.geometry.coords[0].lat, 51.5, 'lat comes from the second tuple field');
  assert.strictEqual(route.geometry.coords[0].lon, -0.1);
  assert.strictEqual(route.description, 'route along Calle 3');
  assert.ok(route.lengthM > 100, 'two hundredths of a degree should measure over 100 m, got ' + route.lengthM);
});

test('classification separates routes from points and says what it skipped', function () {
  const result = kml.classify(kml.parseKml(SAMPLE));
  assert.strictEqual(result.routes.length, 1);
  assert.strictEqual(result.points.length, 1);
  assert.strictEqual(result.skipped.length, 1, 'a polygon is reported, not silently dropped');
  assert.ok(result.routeM > 100);
  assert.strictEqual(result.points[0].lat, 51.501);
});

test('duplicate coordinates are deduplicated and counted', function () {
  const doubled = SAMPLE.replace('</Document>',
    '<Placemark><name>NAP 12 copy</name><Point><coordinates>-0.1010,51.5010,0</coordinates></Point></Placemark></Document>');
  const result = kml.classify(kml.parseKml(doubled));
  assert.strictEqual(result.points.length, 1);
  assert.strictEqual(result.duplicates, 1);
});

test('a KMZ with a stored entry is read through zlib alone', function () {
  const buf = storedZip('doc.kml', SAMPLE);
  const parsed = kml.parseKmz(buf);
  assert.strictEqual(parsed.name, 'Barrio Norte');
  assert.strictEqual(parsed.placemarks.length, 3);
});

test('a deflated KMZ entry is inflated', function () {
  const buf = deflatedZip('doc.kml', SAMPLE);
  const parsed = kml.parseKmz(buf);
  assert.strictEqual(parsed.placemarks.length, 3);
});

test('junk is refused with a reason', function () {
  throws(function () { kml.parseKml('<notkml></notkml>'); }, 'not a KML document');
  throws(function () { kml.parseKmz(Buffer.from('this is not a zip')); }, 'not a zip archive');
  throws(function () { kml.parseKmz(storedZip('readme.txt', 'hello')); }, 'no .kml file');
});

test('coordinates that are not coordinates are dropped, not projected to null island', function () {
  const bad = '<kml><Document><Placemark><name>x</name><Point><coordinates>999,999</coordinates></Point></Placemark></Document></kml>';
  const parsed = kml.parseKml(bad);
  assert.strictEqual(parsed.placemarks.length, 0);
  assert.strictEqual(parsed.unsupported, 1);
});
