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

// A Placemark in a real drawing is often a MultiGeometry: Google Earth splits a road at every
// junction, so one Placemark holds two or three LineStrings. The importer used to read the FIRST
// <Point>/<LineString>/<LinearRing> in a Placemark and nothing else, and still reported
// `unsupported: 0` - so half a road vanished and the caller was told the import was clean. A
// property 10 m from the missing half was then snapped to the far end of the half that was read,
// given a 100 m spur, and reported as needing a drop it does not need. One entry per geometry, in
// document order, is what makes the import's own count true.
const MULTI = '<kml><Document><Placemark><name>Calle 3</name><MultiGeometry>' +
  '<LineString><coordinates>-0.1000,51.5000 -0.1010,51.5000</coordinates></LineString>' +
  '<LineString><coordinates>-0.1010,51.5000 -0.1010,51.5010</coordinates></LineString>' +
  '</MultiGeometry></Placemark></Document></kml>';

test('a MultiGeometry contributes every part, not just the first', function () {
  const parsed = kml.parseKml(MULTI);
  assert.strictEqual(parsed.unsupported, 0, 'nothing in this drawing is unsupported');
  assert.strictEqual(parsed.placemarks.length, 2, 'two LineStrings in one Placemark are two entries');
  assert.deepStrictEqual(parsed.placemarks.map(function (p) { return p.name; }), ['Calle 3', 'Calle 3']);
  const result = kml.classify(parsed);
  assert.strictEqual(result.routes.length, 2, 'both halves are routes');
  // 0.001 deg of longitude at 51.5 N is 0.001 x 111320 x cos(51.5) = 69.2 m, 0.001 deg of latitude is
  // 111.2 m, so the pair measures 180.4 m. The old importer quoted 69.2 - the first leg only.
  close(result.routeM, 180.4, 1.0, 'both legs are measured, got ' + result.routeM + ' m');
});

test('a MultiGeometry that mixes a point with a line yields both', function () {
  const mixed = '<kml><Document><Placemark><name>NAP 12</name><MultiGeometry>' +
    '<Point><coordinates>-0.1010,51.5010</coordinates></Point>' +
    '<LineString><coordinates>-0.1000,51.5000 -0.1010,51.5000</coordinates></LineString>' +
    '</MultiGeometry></Placemark></Document></kml>';
  const result = kml.classify(kml.parseKml(mixed));
  assert.strictEqual(result.routes.length, 1, 'the line is a route');
  assert.strictEqual(result.points.length, 1, 'the point is a candidate node');
});

test('a property on the second half of a split road is snapped to that half, not to the first', function () {
  const street = require('../engine/street');
  const graph = street.buildGraph(MULTI, {});
  assert.strictEqual(graph.stats().edges, 2, 'both halves are edges of the graph');
  // 0.0009 deg of latitude = 100.1 m up the second leg, and the property is on the centreline.
  // Against the truncated graph this same point snapped to the junction with a 100.08 m spur.
  const snapped = street.snap(graph, { lat: 51.5009, lon: -0.1010 });
  close(snapped.spurM, 0, 1, 'a property on the centreline has no spur, got ' + snapped.spurM + ' m');
});

test('a geometry too short to be a route is unsupported, not an empty route', function () {
  const stub = '<kml><Document><Placemark><name>stub</name><LineString>' +
    '<coordinates>-0.1,51.5</coordinates></LineString></Placemark></Document></kml>';
  const parsed = kml.parseKml(stub);
  assert.strictEqual(parsed.placemarks.length, 0);
  assert.strictEqual(parsed.unsupported, 1);
});
