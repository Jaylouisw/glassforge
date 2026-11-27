'use strict';
// A quote opens a quoted field only where a field starts.
//
// RFC 4180 lets a field be quoted (`"12 High St, Flat 2"`), but it does not make a quote *inside*
// an unquoted field a delimiter. The importer treated every `"` as the start of a quoted section,
// so an address carrying an inch mark - `12" duct`, `4" main`, an OCR'd `6"` - opened a quote that
// ran to the end of the file. Two failures came from that one character:
//
//   - the inch mark was swallowed (`12" duct` became `12 duct`), a wrong address nobody could find
//     in the file; and
//   - because the record splitter thought a quoted section was open, it stopped splitting on the
//     newline, so the *next* row's legitimately quoted multi-line address was cut and its tail
//     reported as `rejected: latitude or longitude is empty` - a phantom row in a file that was
//     correct apart from one punctuation character.
//
// The rule now matches the field splitter's promise: a field is quoted only when the quote is the
// first thing in it (after the delimiter, or at the start of a record).
const { test, assert, done } = require('./harness');
const demand = require('../engine/demand');

test('an inch mark in an unquoted field is kept as text', function () {
  const parsed = demand.parseCsv('label,lat,lon,address\nA,52.1,-1.2,12" duct\n');
  assert.strictEqual(parsed.points.length, 1);
  assert.strictEqual(parsed.points[0].address, '12" duct',
    'the inch mark belongs to the address: ' + JSON.stringify(parsed.points[0]));
  assert.strictEqual(parsed.rejected.length, 0);
});

test('an inch mark in one row does not unquote the next row\'s multi-line address', function () {
  const csv = 'label,lat,lon,address\n' +
    'A,52.1,-1.2,12" duct\n' +
    'B,52.2,-1.3,"Unit 4\n12 High St"\n' +
    'C,52.3,-1.4,plain\n';
  const parsed = demand.prepare(csv);
  assert.deepStrictEqual(parsed.points.map(function (p) { return p.address; }),
    ['12" duct', 'Unit 4 12 High St', 'plain']);
  assert.strictEqual(parsed.rejected.length, 0,
    'no row is unusable: ' + JSON.stringify(parsed.rejected));
});

test('a quote at the start of a field is still a quoted field', function () {
  const parsed = demand.parseCsv('label,lat,lon,address\nA,52.1,-1.2,"12"" duct, rear"\n');
  assert.strictEqual(parsed.points.length, 1);
  assert.strictEqual(parsed.points[0].address, '12" duct, rear');
});

done();
