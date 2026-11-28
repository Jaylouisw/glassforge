'use strict';
// An imported street line is refused by name when a vertex cannot be read.
//
// Before this, `normaliseLine` ran every vertex through `geo.isCoordinate` and kept the rest of the
// line, and an edge that lost too much was dropped from the array entirely. Both were silent: a
// three-point street whose last vertex was a blank CSV cell answered a graph whose street ended at
// its second vertex, and a property beyond it was later refused as `not on the street network` -
// naming the candidate's symptom instead of the geometry fault the importer had already seen. A
// dropped edge is a road that vanished with a 200. One undefendable vertex spoils the design, the
// same rule `kml.classify` applies to an unreadable placemark (gh#176) and the BOM applies to a span.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');
const street = engine.street;

const GOOD = [{ lat: 51.5, lon: -0.1010 }, { lat: 51.5, lon: -0.1000 }];

test('a blank cell in a vertex is refused, naming the edge, the vertex and the value', function () {
  const line = [
    { lat: 51.5, lon: -0.1010 },
    { lat: 51.5, lon: -0.1005 },
    { lat: 51.5, lon: '' }
  ];
  // Measured before the fix: this edge alone answered 1 edge / 34.6 m instead of 69.2 m.
  const err = throws(function () {
    street.buildGraph({ edges: [{ id: 'high-st', coords: line }] });
  }, 'vertex 3');
  assert.ok(/high-st/.test(err.message), 'the refusal names the edge id: ' + err.message);
  assert.ok(/edge 1/.test(err.message), 'the refusal names the edge position: ' + err.message);
  assert.ok(/""/.test(err.message), 'the refusal quotes the value it could not read: ' + err.message);
  assert.ok(/lat/.test(err.message) && /lon/.test(err.message), 'and the shape it wants: ' + err.message);
});

test('a line with no readable vertices is refused, not silently dropped beside a good one', function () {
  const err = throws(function () {
    street.buildGraph({
      edges: [
        { id: 'good', coords: GOOD },
        { id: 'junk', coords: [{ lat: 95, lon: 0 }, { lat: null, lon: null }] }
      ]
    });
  }, 'vertex 1');
  // Before the fix this answered 200 with edges: 1 and said nothing about the road that vanished.
  assert.ok(/junk/.test(err.message), err.message);
  assert.ok(/edge 2/.test(err.message), 'the refusal names the second edge of two: ' + err.message);
  assert.ok(/95/.test(err.message), 'the refusal quotes the out-of-range latitude: ' + err.message);
});

test('one vertex is not a line, and is refused by name rather than dropped', function () {
  const err = throws(function () {
    street.buildGraph({ edges: [{ id: 'good', coords: GOOD }, { id: 'stub', coords: [{ lat: 51.5, lon: -0.1 }] }] });
  }, 'stub');
  assert.ok(/1 vertex/.test(err.message), err.message);
});

test('an edge with no coords array is refused by name, not skipped', function () {
  const err = throws(function () {
    street.buildGraph({ edges: [{ id: 'good', coords: GOOD }, { id: 'nocoords' }] });
  }, 'nocoords');
  assert.ok(/edge 2/.test(err.message), err.message);
});

test('a {lat, lon} line is still read, and a third element it does not need is ignored', function () {
  const graph = street.buildGraph({ edges: [{ id: 'main', coords: [
    { lat: 51.5, lon: -0.1010, alt: 12 },
    { lat: 51.5, lon: -0.1000, alt: 12 }
  ] }] });
  // 0.0010 deg of longitude at 51.5 deg N: 0.0010 x 111319.49 x cos(51.5) = 69.29 m
  close(graph.stats().lengthM, 69.29, 0.5, 'the line still measures');
  assert.strictEqual(graph.stats().edges, 1);
});

test('the array form is refused by position too, and a quoted number is not a coordinate', function () {
  // The array form is `[{ coords }]` - the documented "array of polylines" - so a line in it has no
  // id to be named by, and the position is the whole of the name.
  const err = throws(function () {
    street.buildGraph([{ coords: GOOD }, { coords: [{ lat: '51.5', lon: -0.1 }, { lat: 51.5, lon: -0.2 }] }]);
  }, 'vertex 1');
  assert.ok(/edge 2/.test(err.message), err.message);
  assert.ok(/"51.5"/.test(err.message), 'the refusal quotes the string it could not read: ' + err.message);
  assert.ok(err.message.indexOf('("') === -1, 'there is no id to quote: ' + err.message);
});

done();
