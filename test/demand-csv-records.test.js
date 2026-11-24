'use strict';
// A field splitter that honours quotes, fed by a line splitter that does not.
//
// `demand.splitRow` says it is "RFC-4180-ish: quoted fields, doubled quotes, and the delimiter inside
// quotes". RFC 4180 also lets a quoted field contain a *line break*, and that is exactly what an
// address list exported from a CRM carries: "Unit 4\n12 High Street" is one address. `parseCsv` split
// the text on '\n' before it ever reached `splitRow`, so that row became two lines - the address was
// truncated at the break and the tail was parsed as a row with no latitude, which landed in
// `rejected` as a phantom point. Nothing was wrong with the file; the record splitter disagreed with
// the field splitter it feeds.
//
// A file whose quotes never close is not one this importer can classify, so it keeps the old answer
// rather than refusing the whole list - the regression guard at the bottom holds that.
const { test, assert, done } = require('./harness');
const demand = require('../engine/demand');

test('a quoted address that spans two lines is one point, not a point and a phantom row', function () {
  const csv = 'label,lat,lon,address\n' +
    'H1,51.5,-0.1,"Unit 4\n12 High Street"\n' +
    'H2,51.5004,-0.1002,14 High Street\n';
  const parsed = demand.prepare(csv);
  assert.strictEqual(parsed.points.length, 2, JSON.stringify(parsed.points));
  // The line break is folded to a space: the address becomes a node name and a line in the printed
  // plan, and a name with a newline in it breaks the table it is printed in.
  assert.strictEqual(parsed.points[0].address, 'Unit 4 12 High Street');
  assert.strictEqual(parsed.points[0].lat, 51.5);
  assert.strictEqual(parsed.points[1].address, '14 High Street');
  assert.strictEqual(parsed.rejected.length, 0,
    'the tail of the split address used to be rejected as a row: ' + JSON.stringify(parsed.rejected));
});

test('a doubled quote inside a quoted field still decodes to one quote', function () {
  const parsed = demand.prepare('label,lat,lon\n"Casa ""2""",51.5,-0.1\n');
  assert.strictEqual(parsed.points.length, 1);
  assert.strictEqual(parsed.points[0].label, 'Casa "2"');
});

test('a quoted field still carries the delimiter, and a multi-line one keeps its own newline out of the next row', function () {
  const csv = 'label,lat,lon\n"12 High St, Flat 2",51.5,-0.1\n"13 High St",51.5004,-0.1\n';
  const parsed = demand.prepare(csv);
  assert.strictEqual(parsed.points.length, 2);
  assert.strictEqual(parsed.points[0].label, '12 High St, Flat 2');
});

test('an unterminated quote keeps the line-by-line reading instead of swallowing the file', function () {
  // Unbalanced quotes are not RFC 4180; the importer cannot tell where the field ended, so it reads
  // the file the way it always has rather than joining every following row into one record. The
  // row with the stray quote is one unusable row - it reads as a single quoted field with no
  // latitude - and the row after it is still a point; that pair is the guard.
  const csv = 'label,lat,lon\n"Stray,51.5,-0.1\nSecond,51.5004,-0.1002\n';
  const parsed = demand.prepare(csv);
  assert.strictEqual(parsed.points.length, 1, JSON.stringify(parsed.points));
  assert.strictEqual(parsed.points[0].label, 'Second');
  assert.strictEqual(parsed.rejected.length, 1, JSON.stringify(parsed.rejected));
});

done();
