'use strict';
// A demand row's label and address are text, or the row is refused by name.
//
// A CSV cell is text by construction, so the CSV path could never get this wrong. The JSON path copied
// `label` and `address` out of the row as-is. `label` was stringified (`{ label: 5 }` naming the ONT `5`
// was fixed), but `address` was not - and `prepare` falls back to it when the row has no label. Measured
// on main at 74456b7 through the real server: a three-house demand whose last row carried
// `{ address: 5 }` answered `ok: false`, `technology: null`, and all nine candidates refused for
// `node "d1-ont-d3" name must be a string, got a number`. One numeric house number, and the caller is
// told every topology is invalid - the answer never names the row that caused it.
//
// So both fields follow the rule the CSV path already had: a string is itself, a number is its decimal
// text (a cell would have been "5"), an empty or whitespace-only value is absent, and a value with no
// text reading (an object, an array, a boolean) is refused by row and field - because the alternative
// is a node named `[object Object]` printed on the canvas.
const { test, assert, throws, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const HEAD_END = { lat: 51.5, lon: -0.1 };

test('a numeric address is the text a CSV cell would have carried, and the design stands', function () {
  // Three houses, the last one addressed by its number - the shape of an export from a spreadsheet.
  const rows = [
    { lat: 51.501, lon: -0.101 },
    { lat: 51.502, lon: -0.102 },
    { lat: 51.5005, lon: -0.1005, address: 5 }
  ];
  const parsed = engine.demand.prepare(rows);
  assert.deepStrictEqual(parsed.rejected, []);
  assert.strictEqual(parsed.points[2].address, '5');
  // `prepare` falls back from an absent label to the address, so the node name is that same text.
  assert.strictEqual(parsed.points[2].label, '5');

  // The regression: every candidate used to fail on this plant's node name.
  const design = engine.design.synthesise(rows, { headEnd: HEAD_END }, registry);
  assert.strictEqual(design.ok, true, JSON.stringify(design.notes));
  assert.ok(design.plant, 'a design the demand fully describes is offered');
  const named = design.plant.nodes.filter(function (n) { return n.name === '5'; });
  assert.strictEqual(named.length, 1, 'the house keeps its number as text: ' +
    JSON.stringify(design.plant.nodes.map(function (n) { return n.name; })));
  design.plant.nodes.forEach(function (n) {
    assert.strictEqual(typeof n.name, 'string', 'node ' + n.id + ' name ' + JSON.stringify(n.name));
  });
});

test('an object address is refused by row and field, not turned into a node name', function () {
  const parsed = engine.demand.prepare([
    { lat: 51.5, lon: -0.1, address: { line1: '12 High Street' } },
    { lat: 51.501, lon: -0.101, address: 'ok' }
  ]);
  // The row is refused by name rather than dropped: the import answer has to say a house was left out.
  assert.strictEqual(parsed.points.length, 1);
  assert.deepStrictEqual(parsed.rejected.map(function (r) { return r.row; }), [1]);
  assert.ok(/^address must be text/.test(parsed.rejected[0].reason), parsed.rejected[0].reason);
  assert.ok(parsed.rejected[0].reason.indexOf('12 High Street') !== -1,
    'the refusal quotes the value it could not read: ' + parsed.rejected[0].reason);
});

test('an object label is refused, so "[object Object]" is never a node name', function () {
  // `String({})` is `[object Object]`, which passes `nameProblem` - the plant was valid and the label
  // was nonsense. It is the same refusal as the address, with the field named.
  throws(function () {
    engine.demand.prepare([{ lat: 51.5, lon: -0.1, label: { a: 1 } }]);
  }, 'label must be text', 'a demand of one object-labelled row');

  const parsed = engine.demand.prepare([
    { lat: 51.5, lon: -0.1, label: { a: 1 } },
    { lat: 51.501, lon: -0.101, label: 'good' }
  ]);
  assert.strictEqual(parsed.points.length, 1);
  assert.strictEqual(parsed.points[0].label, 'good');
  assert.ok(/^label must be text/.test(parsed.rejected[0].reason), parsed.rejected[0].reason);
});

test('an empty or whitespace-only address is absent, the way a blank CSV cell is', function () {
  const parsed = engine.demand.prepare([
    { lat: 51.5, lon: -0.1, address: '' },
    { lat: 51.501, lon: -0.101, address: '   ' },
    { lat: 51.502, lon: -0.102, address: null }
  ]);
  assert.deepStrictEqual(parsed.rejected, []);
  assert.deepStrictEqual(parsed.points.map(function (p) { return p.address; }), [null, null, null]);
  // With no label and no address the design names the point itself.
  assert.deepStrictEqual(parsed.points.map(function (p) { return p.label; }),
    ['point 1', 'point 2', 'point 3']);
});

test('a numeric label still reads as its text, and a number is not a refusal', function () {
  // The rule `test/demand-input.test.js` pins, kept beside the address's: the two fields cannot
  // disagree about what counts as text.
  const parsed = engine.demand.prepare([
    { label: 5, lat: 51.5, lon: -0.1 },
    { name: 7, lat: 51.5001, lon: -0.1 }
  ]);
  assert.deepStrictEqual(parsed.rejected, []);
  assert.deepStrictEqual(parsed.points.map(function (p) { return p.label; }), ['5', '7']);
});

test('a boolean is not text either, and both bad fields are named once', function () {
  const parsed = engine.demand.prepare([
    { lat: 51.5, lon: -0.1, label: true, address: ['a'] },
    { lat: 51.501, lon: -0.101 }
  ]);
  assert.strictEqual(parsed.points.length, 1);
  assert.ok(/^label and address must be text/.test(parsed.rejected[0].reason), parsed.rejected[0].reason);
});

done();
