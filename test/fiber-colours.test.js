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

test('the base sequence wraps every twelve and is 1-based', function () {
  // This is the twelve-colour sequence a tube is coloured from; a fibre in a tube of more than
  // twelve also carries a tracer, which is tubeFiberColor's job (asserted below).
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
  assert.strictEqual(a.fiberColor.tracer, null, 'a 6-fibre tube never repeats a colour, so no tracer');
});

test('fibres 13-24 of a tube repeat the colours with a black tracer', function () {
  // gh#258: a 24-fibre tube (atlas-lite-airblown-24) printed T01-F01 and T01-F13 both as plain
  // "blue" with the same hex, so the printed plan and the browser diagram gave a crew two
  // indistinguishable fibres in one tray. TIA-598-D repeats the twelve colours for 13-24 with a
  // black tracer, and the repeated black (position 20) takes a white tracer so it can be read.
  for (let i = 1; i <= 12; i++) {
    assert.strictEqual(fiber.addressFor(i, { fibersPerTube: 24 }).fiberColor.tracer, null,
      'fibre ' + i + ' is the plain colour, no tracer');
  }
  assert.deepStrictEqual(fiber.addressFor(13, { fibersPerTube: 24 }).fiberColor,
    { name: 'blue', hex: '#1f6fd0', tracer: 'black' });
  assert.deepStrictEqual(fiber.addressFor(20, { fibersPerTube: 24 }).fiberColor,
    { name: 'black', hex: '#1a1a1a', tracer: 'white' }, 'black on black needs the white tracer');
  assert.deepStrictEqual(fiber.addressFor(24, { fibersPerTube: 24 }).fiberColor,
    { name: 'aqua', hex: '#1fb6c9', tracer: 'black' });
});

test('every fibre of a 24-fibre tube reads differently', function () {
  // The defect in one assertion: a tray whose rows cannot be told apart. 24 strands, 24 descriptions.
  const described = [];
  for (let i = 1; i <= 24; i++) described.push(fiber.describe(fiber.addressFor(i, { fibersPerTube: 24 })));
  assert.strictEqual(new Set(described).size, 24, described.join(' | '));
  assert.strictEqual(described[0], 'T01-F01 blue');
  assert.strictEqual(described[12], 'T01-F13 blue with black tracer');
});

test('the tracer is a fibre-in-tube rule: a tube beyond twelve still wraps plainly', function () {
  // Tube 13 of a 12-per-tube cable is blue, as the standard repeats for tubes; a tube is not a
  // fibrecore with a tracer.
  const a = fiber.addressFor(145);
  assert.strictEqual(a.tube, 13);
  assert.strictEqual(a.tubeColor.name, 'blue');
  assert.strictEqual(a.tubeColor.tracer, undefined);
  // Past 24 the marking is the manufacturer's (Corning ships fibre 20 natural) - base colour, no guess.
  assert.deepStrictEqual(fiber.tubeFiberColor(25), { name: 'blue', hex: '#1f6fd0', tracer: null });
});

test('the colour text is the one place a tracer is spelled out', function () {
  assert.strictEqual(fiber.colorText({ name: 'blue', hex: '#1f6fd0', tracer: null }), 'blue');
  assert.strictEqual(fiber.colorText({ name: 'blue', hex: '#1f6fd0', tracer: 'black' }), 'blue with black tracer');
  assert.strictEqual(fiber.colorText(null), '');
});

test('parseAddress accepts the forms a technician types', function () {
  assert.strictEqual(fiber.parseAddress('t1f7').index, 7);
  assert.strictEqual(fiber.parseAddress('1-7').index, 7);
  assert.strictEqual(fiber.parseAddress('1/7').index, 7);
  assert.strictEqual(fiber.parseAddress('31').index, 31);
  assert.strictEqual(fiber.parseAddress(' T03-F07 ').label, 'T03-F07');
  assert.strictEqual(fiber.parseAddress('nonsense'), null);
  assert.strictEqual(fiber.parseAddress('T1-F13'), null, 'fibre 13 does not exist in a 12-fibre tube');
  // In a 24-fibre tube it does, and it is the blue one with a black tracer.
  assert.strictEqual(fiber.parseAddress('T1-F13', { fibersPerTube: 24 }).fiberColor.tracer, 'black');
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
