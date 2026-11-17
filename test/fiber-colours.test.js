'use strict';
// TIA-598 is the whole point of the splice diagram: the colours have to be the ones on the tray.
const { test, assert, throws, done } = require('./harness');
const fiber = require('../engine/fiber');

test('the twelve colours are in TIA-598 order', function () {
  const names = fiber.COLORS.map(function (c) { return c.name; });
  assert.deepStrictEqual(names, ['blue', 'orange', 'green', 'brown', 'slate', 'white',
    'red', 'black', 'yellow', 'violet', 'rose', 'aqua']);
});

test('every colour carries a hex value a swatch can use', function () {
  for (const colour of fiber.COLORS) assert.ok(/^#[0-9a-f]{6}$/i.test(colour.hex), colour.name + ' has no usable hex');
});

test('colourFor wraps every twelve fibres and is 1-based', function () {
  assert.strictEqual(fiber.colorName(1), 'blue');
  assert.strictEqual(fiber.colorName(12), 'aqua');
  assert.strictEqual(fiber.colorName(13), 'blue');
  assert.strictEqual(fiber.colorName(24), 'aqua');
});

test('a strand resolves to tube and fibre in both directions', function () {
  const a = fiber.addressFor(31);
  assert.strictEqual(a.tube, 3);
  assert.strictEqual(a.fiber, 7);
  assert.strictEqual(a.tubeColor.name, 'green');
  assert.strictEqual(a.fiberColor.name, 'red');
  assert.strictEqual(a.label, 'T03-F07');
  assert.strictEqual(fiber.parseAddress('T03-F07').index, 31);
});

test('addressFor honours a 6-fibre tube', function () {
  const a = fiber.addressFor(7, { fibersPerTube: 6 });
  assert.strictEqual(a.tube, 2);
  assert.strictEqual(a.fiber, 1);
  assert.strictEqual(a.fiberColor.name, 'blue');
});

test('parseAddress accepts the forms a technician types', function () {
  assert.strictEqual(fiber.parseAddress('t1f7').index, 7);
  assert.strictEqual(fiber.parseAddress('1-7').index, 7);
  assert.strictEqual(fiber.parseAddress('1/7').index, 7);
  assert.strictEqual(fiber.parseAddress('31').index, 31);
  assert.strictEqual(fiber.parseAddress(' T03-F07 ').label, 'T03-F07');
  assert.strictEqual(fiber.parseAddress('nonsense'), null);
  assert.strictEqual(fiber.parseAddress('T1-F13'), null, 'fibre 13 does not exist in a 12-fibre tube');
});

test('a plan of 24 fibres is two tubes of twelve, no duplicates', function () {
  const plan = fiber.plan(24);
  assert.strictEqual(plan.length, 24);
  assert.strictEqual(new Set(plan.map(function (a) { return a.label; })).size, 24);
  assert.strictEqual(plan[12].label, 'T02-F01');
});

test('bad input is refused rather than guessed', function () {
  throws(function () { fiber.addressFor(0); }, 'positive integer');
  throws(function () { fiber.addressFor(1.5); }, 'positive integer');
  throws(function () { fiber.plan(0); }, 'positive integer');
  throws(function () { fiber.addressFor(1, { fibersPerTube: 30 }); }, 'fibersPerTube');
});

done();
