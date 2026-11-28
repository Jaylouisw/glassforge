'use strict';
// Import is how a planner gets a route somebody already surveyed, so the parser has to be honest
// about what it read and what it skipped.
const zlib = require('zlib');
const { test, assert, throws, close, done } = require('./harness');
const kml = require('../engine/kml');
const street = require('../engine/street');

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
  // Two entries now: the polygon, and 'Just a folder' - the placemark that holds no geometry at all.
  // This read 1 until the count grew a name: an empty placemark was counted in `unsupported` and then
  // dropped before `classify` saw it, so the list meant to name everything that vanished omitted the
  // one thing that vanished completely.
  assert.strictEqual(result.skipped.length, 2, 'the polygon and the empty placemark are both reported');
  assert.strictEqual(result.skipped.filter(function (s) { return s.type === 'Polygon'; }).length, 1,
    'a polygon is reported, not silently dropped');
  const unread = result.skipped.filter(function (s) { return s.type === 'unsupported'; });
  assert.strictEqual(unread.length, 1);
  assert.strictEqual(unread[0].name, 'Just a folder');
  assert.strictEqual(unread[0].reason, 'no Point, LineString or polygon geometry');
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

test('two routes that share both ends but not their middle are both streets', function () {
  // A side street leaves the main road at one junction and returns at the next: the two routes have
  // the same first and last coordinate and no other vertex in common. Keying a duplicate on the ends
  // alone dropped the second line as if it were the same export twice, so `street.buildGraph` never
  // saw an edge that is drawn on the map and the planner routed around a street that exists.
  const two = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
    '<Placemark><name>Main road</name><LineString><coordinates>' +
    '-0.1000,51.5000,0 -0.1010,51.5000,0 -0.1010,51.5010,0</coordinates></LineString></Placemark>' +
    '<Placemark><name>Parallel street</name><LineString><coordinates>' +
    '-0.1000,51.5000,0 -0.0990,51.5010,0 -0.1010,51.5010,0</coordinates></LineString></Placemark>' +
    '</Document></kml>';
  const result = kml.classify(kml.parseKml(two));
  assert.strictEqual(result.routes.length, 2, 'both streets survive classification');
  assert.strictEqual(result.duplicates, 0);
  assert.ok(result.routeM > 200, 'both route lengths are counted, got ' + result.routeM);
  // The import is the graph: 2 edges per street, 4 nodes, nothing merged away.
  assert.strictEqual(street.buildGraph(two).stats().edges, 4, 'the routing graph has both streets (2 edges each)');
});

test('a route exported twice is still skipped as a duplicate', function () {
  // The old rule is still a rule: the same line, vertex for vertex, is one street, not two.
  const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
    '<Placemark><name>Feeder</name><LineString><coordinates>' +
    '-0.1000,51.5000,0 -0.1010,51.5010,0</coordinates></LineString></Placemark>' +
    '<Placemark><name>Feeder copy</name><LineString><coordinates>' +
    '-0.1000,51.5000,0 -0.1010,51.5010,0</coordinates></LineString></Placemark>' +
    '</Document></kml>';
  const result = kml.classify(kml.parseKml(xml));
  assert.strictEqual(result.routes.length, 1);
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

test('a blank coordinate field is not the zero meridian', function () {
  // `Number('')` is 0, and 0 is a legal longitude - so a tuple with an empty field used to import as
  // a point on the Greenwich meridian. On `origin/main` this document measured 7102.5 m of cable: one
  // blank cell put a phantom bend 0.1 degrees west of the survey in a route that is 111.2 m long.
  const doc = '<?xml version="1.0"?><kml><Document>' +
    '<Placemark><name>Feeder B</name><LineString>' +
    '<coordinates>,51.5000,0 -0.1010,51.5000,0 -0.1010,51.5010,0</coordinates>' +
    '</LineString></Placemark>' +
    '<Placemark><name>NAP 13</name><Point><coordinates>,51.5010,0</coordinates></Point></Placemark>' +
    '</Document></kml>';
  const parsed = kml.parseKml(doc);
  const route = parsed.placemarks.find(function (p) { return p.name === 'Feeder B'; });
  assert.strictEqual(route.geometry.coords.length, 2, 'the blank tuple is not a coordinate');
  assert.ok(route.geometry.coords.every(function (c) { return c.lon < 0; }), 'nothing lands on lon 0');
  // -0.1010,51.5000 -> -0.1010,51.5010 is 0.001 degrees of latitude: 0.001 x 111.2 km = 111 m.
  assert.ok(route.lengthM > 100 && route.lengthM < 120,
    'the route measures what it still shows, got ' + route.lengthM + ' m');
  assert.strictEqual(parsed.placemarks.length, 1, 'a point with no usable tuple has no geometry');
  assert.strictEqual(parsed.unsupported, 1);
  // Dropping is counted, not silent: one tuple on the route, one in the point that lost its only one.
  assert.strictEqual(parsed.droppedCoordinates, 2);
  assert.strictEqual(route.geometry.dropped, 1);
  const classified = kml.classify(parsed);
  assert.strictEqual(classified.droppedCoordinates, 2);
  assert.strictEqual(classified.routes[0].dropped, 1);
});


// A name is text, and XML writes text with entities. Google Earth escapes what its author typed, so
// "Main St & 3rd Ave" is stored as "Main St &amp; 3rd Ave" - and the importer handed that string
// straight to the node label. The printed plan escapes its HTML, so the "&" of "&amp;" became
// "&amp;amp;" and the sheet a crew carries read "Main St &amp; 3rd Ave". A numeric reference
// (`&#233;`) is `e-acute` on the same terms.
const ENTITIES = '<?xml version="1.0"?><kml><Document><name>Campus &amp; depot</name>' +
  '<Placemark><name>Main St &amp; 3rd Ave</name>' +
  '<description>Joint &lt;A&gt; &#233;tage &#x00E9;t&eacute;</description>' +
  '<Point><coordinates>-1.5,52.5,0</coordinates></Point></Placemark>' +
  '<Placemark><name>Route &quot;north&quot; &apos;old&apos;</name>' +
  '<description><![CDATA[a &amp; b]]></description>' +
  '<LineString><coordinates>-1.5,52.5 -1.4,52.6</coordinates></LineString></Placemark>' +
  '<Placemark><name>Café &nbsp;stop &#1114112;</name>' +
  '<Point><coordinates>-1.6,52.6,0</coordinates></Point></Placemark>' +
  '</Document></kml>';

function byName(parsed, name) {
  return parsed.placemarks.find(function (p) { return p.name === name; });
}

test('entity text is decoded into the name the file means', function () {
  const parsed = kml.parseKml(ENTITIES);
  assert.strictEqual(parsed.name, 'Campus & depot', 'the document name is the text, not its markup');
  const main = byName(parsed, 'Main St & 3rd Ave');
  assert.ok(main, 'the ampersand in a name is one character, got ' +
    JSON.stringify(parsed.placemarks.map(function (p) { return p.name; })));
  // `&lt;A&gt;` is a literal "<A>" in the text - stripped as markup it would vanish - and `&#233;` and
  // `&#x00E9;` are character references, each one character.
  assert.strictEqual(main.description, 'Joint <A> étage ét&eacute;');
  const route = byName(parsed, 'Route "north" \'old\'');
  assert.ok(route, 'quot and apos are quotes, got ' +
    JSON.stringify(parsed.placemarks.map(function (p) { return p.name; })));
  // The classified route carries the decoded name too: this is the string a design turns into a node.
  assert.strictEqual(kml.classify(parsed).routes[0].name, 'Route "north" \'old\'');
});

// The other half of the rule: a reference this importer cannot resolve is left exactly as written.
// CDATA is literal by definition, so its content is never decoded; `&eacute;` and `&nbsp;` are not two
// of XML's five predefined entities and there is no DTD here to resolve them, so guessing a character
// would be the same invention as a defaulted loss. `&#1114112;` is past the last code point.
test('an entity this importer cannot resolve is left as written, and CDATA is literal', function () {
  const parsed = kml.parseKml(ENTITIES);
  const route = byName(parsed, 'Route "north" \'old\'');
  assert.strictEqual(route.description, 'a &amp; b', 'CDATA is literal: its ampersand is not markup');
  const cafe = byName(parsed, 'Café &nbsp;stop &#1114112;');
  assert.ok(cafe, 'the sentence keeps what the file wrote, got ' +
    JSON.stringify(parsed.placemarks.map(function (p) { return p.name; })));
});

// A Placemark with nothing this importer can read is counted (`unsupported`) and then its name was
// lost: `/api/import/kml` answered `unsupported: 3` with `skipped: []`, so a user with a file of
// recorded tracks was told three things were unsupported and which three were a secret. The street
// importer was worse - the same file was refused as "the KML contains no LineStrings ... (0 point(s)
// were found instead)", a sentence that says the file held points when it held tracks. `classify`
// already promises `skipped` is "anything else, with the reason, so the user is not told 'imported
// 40 items' and left to discover that 12 of them vanished"; a placemark with no readable geometry is
// the case that vanished hardest, because `parseKml` dropped it before `classify` ever saw it.
const TRACK = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2" ' +
  'xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>' +
  '<Placemark><name>Walk to depot</name><gx:Track>' +
  '<when>2026-11-01T10:00:00Z</when><when>2026-11-01T10:01:00Z</when>' +
  '<gx:coord>-0.1 51.5 0</gx:coord><gx:coord>-0.101 51.501 0</gx:coord>' +
  '</gx:Track></Placemark>' +
  '<Placemark><name>Feeder B</name><LineString>' +
  '<coordinates>-0.2,51.5 -0.21,51.5</coordinates></LineString></Placemark>' +
  '</Document></kml>';

test('a placemark with no readable geometry is named, not only counted', function () {
  const parsed = kml.parseKml(TRACK);
  assert.strictEqual(parsed.unsupported, 1, 'one placemark holds nothing this importer reads');
  assert.strictEqual(parsed.unsupportedPlacemarks.length, 1, 'the count and the list agree');
  assert.strictEqual(parsed.unsupportedPlacemarks[0].name, 'Walk to depot');
  assert.ok(/gx:Track/.test(parsed.unsupportedPlacemarks[0].reason),
    'the reason names what the file holds, got ' + JSON.stringify(parsed.unsupportedPlacemarks[0].reason));
  const classified = kml.classify(parsed);
  assert.strictEqual(classified.unsupported, 1, 'the classified answer carries the count too');
  const unread = classified.skipped.filter(function (s) { return s.type === 'unsupported'; });
  assert.strictEqual(unread.length, 1, 'it is in the one list of what did not make it, got ' +
    JSON.stringify(classified.skipped));
  assert.strictEqual(unread[0].name, 'Walk to depot');
  assert.ok(/gx:Track/.test(unread[0].reason));
});

test('a street file that holds only a track says which placemark it could not read', function () {
  const trackOnly = TRACK.replace(/<Placemark><name>Feeder B<\/name>[\s\S]*?<\/Placemark>/, '');
  const err = throws(function () { street.buildGraph(trackOnly, {}); }, 'no LineStrings',
    'a track is not a street');
  // The old sentence said "0 point(s) were found instead" - the file held a track, not points - and
  // named nothing. The placemark and the reason are both in it now.
  assert.ok(err.message.indexOf('Walk to depot') !== -1,
    'the refusal names the placemark, got: ' + err.message);
  assert.ok(err.message.indexOf('gx:Track') !== -1,
    'the refusal names what the placemark holds, got: ' + err.message);
});
