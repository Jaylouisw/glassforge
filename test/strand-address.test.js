'use strict';
// A strand is addressed by its own cable's tube geometry, not by a default of twelve.
//
// Every cable part publishes `fibersPerTube` and `parts.validate` rejects anything outside 1..24, but
// for a long time nothing in the engine read it: `fiber.addressFor(index)` was called with no options,
// so a 24-fibre ribbon's twenty-fifth strand was labelled T03-F01 (tube 3, fibre 1) when the tray it
// lives in says T02-F01. A splice sheet that names the wrong tube is the one error a crew cannot work
// around, so the address has to come from the cable the strand is actually in.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

/** The real catalogue plus one legal part the catalogue does not carry yet: a 48-fibre ribbon, 24 per tube. */
function registryWithRibbon() {
  const loaded = engine.parts.loadSpecs();
  const ribbon = {
    kind: 'cable',
    model: 'test-ribbon-48',
    label: 'Test ribbon 48F (24 per tube)',
    vendor: 'test',
    fiberCount: 48,
    fibersPerTube: 24,
    construction: 'ribbon',
    attenuationDbPerKm: { '1310': 0.35, '1490': 0.22, '1550': 0.21 },
    drumM: 2000,
    sourceUrl: 'https://example.invalid/test-ribbon-48'
  };
  const registry = new engine.parts.Registry(loaded.specs.concat([ribbon]));
  const check = engine.parts.validateSpec(ribbon);
  assert.ok(check.ok, 'the synthetic part must itself be legal: ' + check.errors.join('; '));
  return registry;
}

const registry = registryWithRibbon();

/** A 12-per-tube loose cable of the same size, for the side-by-side case. */
const LOOSE_48 = 'g652d-loose-48';
const RIBBON_48 = 'test-ribbon-48';

test('the default tube size is twelve, and 24-per-tube is a different address', function () {
  // 12 per tube: strand 25 -> tube 3, fibre 1.  24 per tube: strand 25 -> tube 2, fibre 1.
  assert.strictEqual(engine.fiber.addressFor(25).label, 'T03-F01');
  assert.strictEqual(engine.fiber.addressFor(25, { fibersPerTube: 24 }).label, 'T02-F01');
  assert.strictEqual(engine.fiber.addressFor(48, { fibersPerTube: 24 }).label, 'T02-F24');
});

test('a closure addresses a strand in the tube geometry of the cable it arrives on', function () {
  const plant = {
    nodes: [
      { id: 'o1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'c1', type: 'closure', model: 'mufa-inline-24' }
    ],
    spans: [{ id: 's1', from: 'o1', to: 'c1', cable: RIBBON_48, lengthM: 800, strands: [1, 25, 48] }]
  };
  const table = engine.network.spliceTable(plant, registry);
  const rows = table.points[0].rows;
  const byStrand = new Map(rows.map(function (r) { return [r.strand, r]; }));
  assert.strictEqual(byStrand.get(1).address, 'T01-F01');
  assert.strictEqual(byStrand.get(25).address, 'T02-F01', 'strand 25 is in tube 2 of a 24-fibre tube');
  assert.strictEqual(byStrand.get(48).address, 'T02-F24');
  // This used to say only "2 * 24 + 24 wraps the twelve-colour sequence: fibre 24 is aqua" and stop
  // there, which read the wrap as the whole story. Past twelve a fibre also carries a tracer, so the
  // row says aqua *with a black tracer* and the first twelve stay plain (gh#258).
  assert.strictEqual(byStrand.get(48).colour, 'aqua');
  assert.strictEqual(byStrand.get(48).tracer, 'black');
  assert.strictEqual(byStrand.get(1).tracer, null, 'fibre 1 is the plain colour');
  assert.strictEqual(byStrand.get(25).tracer, null, 'fibre 1 of tube 2 is plain too: the tracer follows the fibre position');
});

test('two fibres twelve positions apart in one 24-fibre tray are told apart by the tracer', function () {
  // The defect in the sheet: T01-F01 and T01-F13 both read plain "blue" with the same hex, so a crew
  // had two indistinguishable fibres in one tray (gh#258).
  const plant = {
    nodes: [
      { id: 'o1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'c1', type: 'closure', model: 'mufa-inline-24' }
    ],
    spans: [{ id: 's1', from: 'o1', to: 'c1', cable: RIBBON_48, lengthM: 800, strands: [1, 13, 20] }]
  };
  const rows = new Map(engine.network.spliceTable(plant, registry).points[0].rows
    .map(function (r) { return [r.strand, r]; }));
  const first = rows.get(1);
  const blueTracer = rows.get(13);
  assert.strictEqual(first.address, 'T01-F01');
  assert.strictEqual(blueTracer.address, 'T01-F13');
  assert.strictEqual(first.colour, 'blue');
  assert.strictEqual(blueTracer.colour, 'blue');
  assert.strictEqual(first.tracer, null);
  assert.strictEqual(blueTracer.tracer, 'black');
  assert.strictEqual(engine.fiber.colorText(first), 'blue');
  assert.strictEqual(engine.fiber.colorText(blueTracer), 'blue with black tracer');
  // Position 20 repeats black, so its tracer is white: black on black cannot be read in a tray.
  assert.strictEqual(rows.get(20).tracer, 'white');
  assert.strictEqual(rows.get(20).colour, 'black');
});

test('a closure joining two cables addresses each side in its own cable', function () {
  const plant = {
    nodes: [
      { id: 'o1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'c1', type: 'closure', model: 'mufa-inline-24' },
      { id: 'x1', type: 'ont', model: 'gpon-ont-4ge' }
    ],
    spans: [
      { id: 's1', from: 'o1', to: 'c1', cable: LOOSE_48, lengthM: 900, strands: [25] },
      { id: 's2', from: 'c1', to: 'x1', cable: RIBBON_48, lengthM: 90, strands: [25] }
    ]
  };
  const rows = engine.network.spliceTable(plant, registry).points[0].rows;
  const onLoose = rows.find(function (r) { return r.span === 's1'; });
  const onRibbon = rows.find(function (r) { return r.span === 's2'; });
  assert.strictEqual(onLoose.address, 'T03-F01', '12 fibres per tube on the loose cable');
  assert.strictEqual(onRibbon.address, 'T02-F01', '24 fibres per tube on the ribbon');
  assert.deepStrictEqual(onLoose.splicedTo, ['s2']);
  assert.deepStrictEqual(onRibbon.splicedTo, ['s1']);
});

test('a splitter port row is addressed in its own cable too', function () {
  const plant = {
    nodes: [
      { id: 'o1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 't1', type: 'closure', model: 'splitter-box-16' },
      { id: 'sp1', type: 'splitter', model: 'plc-1x8-sca', name: 'SPL 1:8' },
      { id: 'x1', type: 'ont', model: 'gpon-ont-4ge' }
    ],
    spans: [
      { id: 's1', from: 'o1', to: 't1', cable: LOOSE_48, lengthM: 700, strands: [1] },
      { id: 's2', from: 't1', to: 'sp1', cable: RIBBON_48, lengthM: 1, purpose: 'splitter-tail', strands: [25] },
      { id: 's3', from: 'sp1', to: 'x1', cable: 'g657a2-drop-1', lengthM: 40, strands: [1] }
    ]
  };
  const table = engine.network.spliceTable(plant, registry);
  const point = table.points.find(function (p) { return p.node === 'sp1'; });
  const input = point.rows.find(function (r) { return r.via === 'splitter-input'; });
  assert.strictEqual(input.span, 's2');
  assert.strictEqual(input.address, 'T02-F01', 'the tail is 24-per-tube cable');
});

test('a 1-fibre drop is unaffected: one tube, one fibre', function () {
  const plant = {
    nodes: [
      { id: 'c1', type: 'closure', model: 'mufa-inline-24' },
      { id: 'x1', type: 'ont', model: 'gpon-ont-4ge' }
    ],
    spans: [{ id: 's1', from: 'c1', to: 'x1', cable: 'g657a2-drop-1', lengthM: 40, strands: [1] }]
  };
  const row = engine.network.spliceTable(plant, registry).points[0].rows[0];
  assert.strictEqual(row.address, 'T01-F01');
  assert.strictEqual(row.colour, 'blue');
});

test('an unknown cable model still renders an address rather than throwing', function () {
  const plant = {
    nodes: [
      { id: 'c1', type: 'closure', model: 'mufa-inline-24' },
      { id: 'x1', type: 'ont', model: 'gpon-ont-4ge' }
    ],
    spans: [{ id: 's1', from: 'c1', to: 'x1', cable: 'not-a-cable', lengthM: 40, strands: [25] }]
  };
  const row = engine.network.spliceTable(plant, registry).points[0].rows[0];
  assert.strictEqual(row.address, 'T03-F01', 'no cable geometry to read: the standard default of twelve');
});

done();
