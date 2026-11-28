'use strict';
// A refused demand row is named by the line of the input it sits on, header and comments included.
//
// `docs/API.md` promises `row` is "the 1-based line of the input, header included", because the
// figure exists to send a planner to the line that is wrong. The parser filtered comments and blank
// records first and then numbered what survived, so every `# note` or blank line above a bad record
// moved it up the answer: a row on line 4 of a commented survey was refused as "row 3". The quoted
// text was the right record, so nothing looked broken - the planner was simply sent to the wrong
// line in their own file, and one further off per comment.
const { test, assert, done } = require('./harness');
const demand = require('../engine/demand');

function rows(parsed) {
  return parsed.rejected.map(function (r) { return r.row; });
}

test('a comment above the header does not shift the line a bad record is named by', function () {
  // 1 "# survey" / 2 header / 3 Casa / 4 Missing - the bad record is on line 4.
  const parsed = demand.prepare('# survey 2026-11-28\nlabel,lat,lon\nCasa,51.5,-0.1\nMissing,,-0.1\n');
  assert.strictEqual(parsed.points.length, 1);
  assert.deepStrictEqual(rows(parsed), [4], 'the row is the input line, not the third kept record');
  assert.strictEqual(parsed.rejected[0].text.indexOf('Missing') , 0);
});

test('blank lines and more than one comment each count a line', function () {
  // 1 "# a" / 2 blank / 3 "# b" / 4 header / 5 Casa / 6 Missing - line 6.
  const csv = '# a\n\n# b\nlabel,lat,lon\nCasa,51.5,-0.1\nMissing,,-0.1\n';
  const parsed = demand.prepare(csv);
  assert.strictEqual(parsed.points.length, 1);
  assert.deepStrictEqual(rows(parsed), [6]);
});

test('a quoted address that spans two lines moves the next row by the lines it occupies', function () {
  // 1 header / 2-3 "Unit 4<newline>12 High St" / 4 Missing - the address is one record on two lines,
  // so the bad record is still line 4, not line 3.
  const csv = 'label,lat,lon\n"Unit 4\n12 High St",51.5,-0.1\nMissing,,-0.1\n';
  const parsed = demand.prepare(csv);
  assert.strictEqual(parsed.points.length, 1);
  assert.deepStrictEqual(rows(parsed), [4]);
});

test('a headerless file with a comment above it is numbered from the first line of the file', function () {
  // 1 "# survey" / 2 Casa (assumed header) / 3 Missing - line 3.
  const parsed = demand.prepare('# survey\nCasa,51.5,-0.1\nMissing,,-0.1\n');
  assert.strictEqual(parsed.meta.assumedHeader, true);
  assert.strictEqual(parsed.points.length, 1);
  assert.deepStrictEqual(rows(parsed), [3]);
});

test('several bad rows around one comment keep the file line of each', function () {
  // 1 header / 2 comment / 3 Missing / 4 Casa / 5 Text - lines 3 and 5.
  const csv = 'label,lat,lon\n# field notes\nMissing,,-0.1\nCasa,51.5,-0.1\nText,abc,def\n';
  const parsed = demand.prepare(csv);
  assert.strictEqual(parsed.points.length, 1);
  assert.deepStrictEqual(rows(parsed), [3, 5]);
});

test('without a comment the numbering is unchanged', function () {
  // 1 header / 2 Good / 3 Missing / 4 Out of range / 5 Text - [3, 4, 5], the documented example.
  const csv = 'label,lat,lon\nGood,51.5,-0.1\nMissing,,-0.1\nOut of range,999,-0.1\nText,abc,def\n';
  assert.deepStrictEqual(rows(demand.prepare(csv)), [3, 4, 5]);
});

done();
