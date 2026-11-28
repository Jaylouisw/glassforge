'use strict';
// A demand row's `label` and `address` both become node names, so both are text or they are refused.
//
// `parseArray` stringified `label` but not `address`, and `prepare` falls back with
// `label: p.label || p.address`. A house number arriving as a JSON number (`{ address: 5 }`) therefore
// became the numeric node name `5`, and `network.validate` refused the plant the design had just
// built: nine candidates, every one "node \"d1-ont-d3\" name must be a string, got a number", and
// `rejected: []` - nothing named the one bad cell. The CSV path could never hit this: a cell is text.
//
// The rule is now one rule for both fields: a string is itself (blank means absent, trimmed the way a
// CSV cell is), a finite number is its decimal text, and a value with no text reading is refused by
// row and field so the caller learns which cell to fix.
const { test, assert } = require('./harness');
const demand = require('../engine/demand');
const engine = require('../engine');
const registry = engine.createRegistry();

test('a numeric address is the text "5", the way a CSV cell would have been', function () {
  const parsed = demand.prepare([
    { lat: 51.501, lon: -0.101 },
    { lat: 51.502, lon: -0.102 },
    { lat: 51.5005, lon: -0.1005, address: 5 }
  ]);
  assert.strictEqual(parsed.points.length, 3);
  assert.strictEqual(parsed.points[2].label, '5');
  assert.strictEqual(parsed.points[2].address, '5');
  assert.strictEqual(parsed.rejected.length, 0, 'a numeric address is usable, not a refusal');
});

test('one numeric address designs a feasible PON, not nine failed candidates', function () {
  // Before the fix this answered ok:false with a node-id refusal on every candidate and nothing in
  // `demand.rejected`. Measured on main at 74456b7.
  const out = engine.design.synthesise([
    { lat: 51.501, lon: -0.101 },
    { lat: 51.502, lon: -0.102 },
    { lat: 51.5005, lon: -0.1005, address: 5 }
  ], { headEnd: { lat: 51.5, lon: -0.1 } }, registry);
  assert.strictEqual(out.ok, true, (out.notes || []).join(' | '));
  assert.ok(out.plant, 'a feasible design carries its plant');
  const named = out.plant.nodes.filter(function (n) { return n.name === '5'; });
  assert.strictEqual(named.length, 1, 'the address is the ONT name, as text');
  assert.strictEqual(typeof named[0].name, 'string');
  assert.deepStrictEqual(out.demand.rejected, []);
});

test('an object address is refused by row and field, not designed as [object Object]', function () {
  const parsed = demand.prepare([
    { lat: 51.5, lon: -0.1, address: { line1: 'x' } },
    { lat: 51.501, lon: -0.1, label: 'Casa 4' }
  ]);
  assert.strictEqual(parsed.points.length, 1, 'the good row still designs');
  assert.strictEqual(parsed.points[0].label, 'Casa 4');
  assert.strictEqual(parsed.rejected.length, 1);
  assert.strictEqual(parsed.rejected[0].row, 1);
  assert.ok(/address must be text/.test(parsed.rejected[0].reason), parsed.rejected[0].reason);
});

test('an object label is refused, so it cannot become the node name "[object Object]"', function () {
  const parsed = demand.prepare([
    { lat: 51.5, lon: -0.1, label: {} },
    { lat: 51.501, lon: -0.1, label: 'Casa 4' }
  ]);
  assert.strictEqual(parsed.points.length, 1);
  assert.strictEqual(parsed.rejected.length, 1);
  assert.strictEqual(parsed.rejected[0].row, 1);
  assert.ok(/label must be text/.test(parsed.rejected[0].reason), parsed.rejected[0].reason);
});

test('a boolean or an array in either text field is refused, never stringified', function () {
  // `String(true)` is "true" and `String([1,2])` is "1,2": both are names nobody typed, and the
  // issue's rule is text-or-number, so the row is named as a refusal.
  const parsed = demand.prepare([
    { lat: 51.5, lon: -0.1, address: true },
    { lat: 51.501, lon: -0.1, label: ['a', 'b'] },
    { lat: 51.502, lon: -0.1, label: 'Casa 6' }
  ]);
  assert.strictEqual(parsed.points.length, 1);
  assert.deepStrictEqual(parsed.rejected.map(function (r) { return r.row; }), [1, 2]);
  assert.ok(/address must be text/.test(parsed.rejected[0].reason), parsed.rejected[0].reason);
  assert.ok(/label must be text/.test(parsed.rejected[1].reason), parsed.rejected[1].reason);
});

test('a whitespace-only label or address is absent, the way a CSV cell is trimmed', function () {
  // `'   '` is truthy, so the old `p.label || p.address` kept it and named the ONT a run of spaces.
  const parsed = demand.prepare([
    { lat: 51.5, lon: -0.1, label: '   ', address: '  ' },
    { lat: 51.501, lon: -0.1, label: '  Casa 2  ' }
  ]);
  assert.strictEqual(parsed.points[0].label, 'point 1');
  assert.strictEqual(parsed.points[0].address, null);
  assert.strictEqual(parsed.points[1].label, 'Casa 2', 'a padded label is the trimmed label');
});

test('a numeric name is still text, as the label test has always pinned', function () {
  const parsed = demand.prepare([
    { name: 7, lat: 51.5, lon: -0.1 },
    { label: 0, lat: 51.501, lon: -0.1 }
  ]);
  // A number is its decimal text; 0 is a real value and must not fall through to "point 2".
  assert.deepStrictEqual(parsed.points.map(function (p) { return p.label; }), ['7', '0']);
});
