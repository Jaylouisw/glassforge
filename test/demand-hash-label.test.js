'use strict';
// A demand row is placed or refused - it is never swallowed.
//
// `#` is not a documented comment syntax anywhere in the project, but the CSV reader treated every
// record whose first character was `#` as a comment and dropped it before anything could place it or
// report it. The label column is the first column, so the row was an address the way a street writes
// one: `#12 Calle 3,51.5,-0.1`. Measured on this importer before the fix, that file of two houses
// parsed to `points: 1, rejected: 0` - a design one house short, with no sentence naming the house.
//
// The rule now: a record with a field separator is a row (placed, or rejected by name); a bare
// `# ...` sentence with no fields is a comment. The cost is deliberate and is named by a test below:
// a note that contains a comma becomes a rejected row rather than vanishing.
const { test, assert } = require('./harness');
const demand = require('../engine/demand');

test('a row whose label starts with # is a point, not a comment', function () {
  const parsed = demand.prepare('label,lat,lon\n#12 Calle 3,51.5,-0.1\nCasa 4,51.501,-0.1\n');
  assert.deepStrictEqual(parsed.points.map(function (p) { return p.label; }), ['#12 Calle 3', 'Casa 4']);
  assert.strictEqual(parsed.points[0].lat, 51.5);
  assert.strictEqual(parsed.rejected.length, 0, 'a placed row is not a rejection either');
});

test('a headerless list whose first row starts with # still has that row', function () {
  // Before the fix the first row was dropped, so the second house became the assumed header and the
  // list silently lost a point (1 point, assumedHeader, 0 rejected).
  const parsed = demand.prepare('#12 Calle 3,51.5,-0.1\nCasa 6,51.501,-0.1\n');
  assert.strictEqual(parsed.meta.assumedHeader, true);
  assert.deepStrictEqual(parsed.points.map(function (p) { return p.label; }), ['#12 Calle 3', 'Casa 6']);
});

test('a bare # sentence is still a comment', function () {
  const parsed = demand.prepare('label,lat,lon\n# survey notes\nCasa,51.5,-0.1\n');
  assert.strictEqual(parsed.points.length, 1);
  assert.strictEqual(parsed.points[0].label, 'Casa');
  assert.strictEqual(parsed.rejected.length, 0, 'a comment is not a rejected row');
});

test('a # row with an empty coordinate is rejected by name, not swallowed', function () {
  const parsed = demand.prepare('label,lat,lon\n#12 Calle 3,,-0.1\nCasa,51.5,-0.1\n');
  assert.strictEqual(parsed.points.length, 1);
  assert.deepStrictEqual(parsed.rejected.map(function (r) { return r.row; }), [2]);
  assert.strictEqual(parsed.rejected[0].reason, 'latitude or longitude is empty');
  assert.ok(parsed.rejected[0].text.indexOf('#12 Calle 3') === 0, parsed.rejected[0].text);
});

test('a # note carrying a comma is a rejected row, so the note is visible', function () {
  // The other side of "nothing is swallowed": this importer cannot tell a note from a fielded row, so
  // it reports the row instead of guessing. The note stays on the rejection list, where a planner can
  // read it, instead of disappearing with the coordinate-less row it looks like.
  const parsed = demand.prepare('label,lat,lon\n# notes, see sheet 2\nCasa,51.5,-0.1\n');
  assert.strictEqual(parsed.points.length, 1);
  assert.strictEqual(parsed.rejected.length, 1);
  assert.strictEqual(parsed.rejected[0].row, 2);
  assert.strictEqual(parsed.rejected[0].reason, 'latitude or longitude is empty');
});
