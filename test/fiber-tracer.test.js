'use strict';
// TIA-598-D does not stop at twelve. It repeats the twelve base colours four times in a 48-position
// group and marks each repeat: 13-24 carry a black tracer, 25-36 a double black tracer, 37-48 a
// single green stripe (and the repeat of the base colour that would hide the mark takes an
// alternative - white tracer on black, double white, orange on green). Before this, a 24-fibre tube
// printed `T01-F01 blue` beside `T01-F13 blue` - same colour, same swatch - and a 432-fibre ribbon
// cable's tube 25 printed the same blue as tube 1. The splice schedule is the one place a crew
// reads that address in a tray.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const fiber = engine.fiber;

test('the first twelve carry no marking, so a 12-fibre reader sees what it always saw', function () {
  // No extra key at all on the base cycle: `colorFor(1)` deep-equals the COLORS entry.
  assert.deepStrictEqual(fiber.colorFor(1), { name: 'blue', hex: '#1f6fd0' });
  assert.deepStrictEqual(fiber.colorFor(12), { name: 'aqua', hex: '#1fb6c9' });
  assert.strictEqual(fiber.colorFor(12).marking, undefined);
});

test('positions 13-24 carry the black tracer, and the second black a white one', function () {
  // 13 = 1 + 12 -> blue, marked. 20 = 8 + 12 -> the repeated black, where a black tracer would be
  // invisible, so TIA-598-D gives it a white tracer.
  const thirteen = fiber.colorFor(13);
  assert.strictEqual(thirteen.name, 'blue');
  assert.strictEqual(thirteen.marking, 'black tracer');
  assert.strictEqual(thirteen.label, 'blue with black tracer');
  const twenty = fiber.colorFor(20);
  assert.strictEqual(twenty.name, 'black');
  assert.strictEqual(twenty.marking, 'white tracer');
  assert.strictEqual(twenty.label, 'black with white tracer');
  assert.strictEqual(fiber.colorFor(24).label, 'aqua with black tracer');
  // The base name is unchanged: `colorName` still answers the twelve colours.
  assert.strictEqual(fiber.colorName(13), 'blue');
});

test('positions 25-48 carry the double black tracer and then the green stripe', function () {
  // 25 = 1 + 24 -> blue again a third time; the standard's marking is a double black tracer.
  assert.strictEqual(fiber.colorFor(25).label, 'blue with double black tracer');
  assert.strictEqual(fiber.colorFor(32).label, 'black with double white tracer');
  assert.strictEqual(fiber.colorFor(36).label, 'aqua with double black tracer');
  // 37-48 uses one green stripe, and green itself takes an orange stripe so it shows (39 = 3 + 36).
  assert.strictEqual(fiber.colorFor(37).label, 'blue with green stripe');
  assert.strictEqual(fiber.colorFor(39).label, 'green with orange stripe');
  assert.strictEqual(fiber.colorFor(48).label, 'aqua with green stripe');
  // Above 48 the marking is by agreement between maker and buyer, so the base colour returns and the
  // tube/fibre number identifies the position rather than a guessed marking.
  assert.strictEqual(fiber.colorFor(49).marking, undefined);
  assert.strictEqual(fiber.colorFor(49).name, 'blue');
});

test('a 24-fibre tube addresses F13 as blue with a black tracer, and reads it back', function () {
  const a = fiber.addressFor(13, { fibersPerTube: 24 });
  assert.strictEqual(a.tube, 1);
  assert.strictEqual(a.fiber, 13);
  assert.strictEqual(a.label, 'T01-F13');
  assert.strictEqual(a.fiberColor.marking, 'black tracer');
  assert.strictEqual(fiber.parseAddress('T01-F13', { fibersPerTube: 24 }).index, 13);
  // A tube number above twelve follows the same rule: tube 13 of a 12-fibre-tube cable is blue with
  // a black tracer, and tube 25 of a 432-fibre ribbon cable (36 tubes of 12) is blue with a double one.
  const tube13 = fiber.addressFor(13 * 12, { fibersPerTube: 12 });
  assert.strictEqual(tube13.tube, 13);
  assert.strictEqual(tube13.tubeColor.marking, 'black tracer');
  const tube25 = fiber.addressFor(25 * 12, { fibersPerTube: 12 });
  assert.strictEqual(tube25.tube, 25);
  assert.strictEqual(tube25.tubeColor.label, 'blue with double black tracer');
});

test('a splice on a 24-fibre tube no longer shows two identical colours', function () {
  const registry = engine.createRegistry();
  const plant = {
    nodes: [
      { id: 'c1', type: 'closure', model: 'nap-8', name: 'NAP 1' },
      { id: 'x1', type: 'ont', model: 'gpon-ont-1ge', name: 'Casa 1' }
    ],
    spans: [
      // atlas-lite-airblown-24 is 24 fibres in one tube (`fibersPerTube: 24`).
      { id: 's1', from: 'c1', to: 'x1', cable: 'atlas-lite-airblown-24', lengthM: 40, strands: [1, 13] }
    ]
  };
  const table = engine.network.spliceTable(plant, registry);
  const rows = table.points[0].rows;
  const one = rows.find(function (r) { return r.strand === 1; });
  const thirteen = rows.find(function (r) { return r.strand === 13; });
  // The base colour is still the twelve-colour name, and the swatch is that colour.
  assert.strictEqual(one.colour, 'blue');
  assert.strictEqual(thirteen.colour, 'blue');
  assert.strictEqual(one.hex, thirteen.hex);
  // What separates them is the marking, as a field and as the string the plan prints.
  assert.strictEqual(one.marking, null);
  assert.strictEqual(thirteen.marking, 'black tracer');
  assert.strictEqual(one.colourLabel, 'blue');
  assert.strictEqual(thirteen.colourLabel, 'blue with black tracer');
  assert.notStrictEqual(one.colourLabel, thirteen.colourLabel);
  // The human string for the splice line distinguishes them too.
  assert.notStrictEqual(fiber.describe(fiber.addressFor(1, { fibersPerTube: 24 })),
    fiber.describe(fiber.addressFor(13, { fibersPerTube: 24 })));
});

test('a 12-fibre cable is unchanged: no marking, the base colour as before', function () {
  const registry = engine.createRegistry();
  const plant = {
    nodes: [
      { id: 'c1', type: 'closure', model: 'nap-8', name: 'NAP 1' },
      { id: 'x1', type: 'ont', model: 'gpon-ont-1ge', name: 'Casa 1' }
    ],
    spans: [
      { id: 's1', from: 'c1', to: 'x1', cable: 'g652d-loose-12', lengthM: 40, strands: [1, 12] }
    ]
  };
  const rows = engine.network.spliceTable(plant, registry).points[0].rows;
  for (const row of rows) {
    assert.strictEqual(row.marking, null, 'a 12-fibre tube has no repeated position');
    assert.strictEqual(row.colourLabel, row.colour);
  }
  const twelve = rows.find(function (r) { return r.strand === 12; });
  assert.strictEqual(twelve.colour, 'aqua');
  assert.strictEqual(twelve.colourLabel, 'aqua');
});

done();
