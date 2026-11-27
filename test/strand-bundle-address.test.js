'use strict';
// A strand index on a bundled span is continuous across the whole bundle, but a tray is not.
//
// `spans[].bundles` runs N whole cables down one route (SPEC §5) and the ledger, the run and the
// splice sheet all number strands 1..N*fibersPerCable (SPEC §6). The sheet, however, addressed every
// row with `fiber.addressFor(index)` - the index read as if it were inside one cable. On a
// `2 x g652d-loose-12` span strand 18 printed `T02-F06`: a 12-fibre loose tube has one tube, so there
// is no tube 2, and the fibre is the sixth of cable 2. The crew cannot resolve the row to a cable,
// which is the one thing the sheet exists to answer. gh#95.
const { test, assert, throws, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const BUNDLE = 'g652d-loose-12';

// olt --2 x 12--> closure: 24 fibres of capacity, one tube in each cable.
function bundledClosure(strands, bundles) {
  return {
    nodes: [
      { id: 'o1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'c1', type: 'closure', model: 'mufa-inline-24' }
    ],
    spans: [{ id: 's1', from: 'o1', to: 'c1', cable: BUNDLE, bundles: bundles || 2, lengthM: 900, strands: strands }]
  };
}

function rowsByStrand(plant) {
  return new Map(engine.network.spliceTable(plant, registry).points[0].rows
    .map(function (r) { return [r.strand, r]; }));
}

test('a bundled closure row names the cable and the tray inside it', function () {
  const rows = rowsByStrand(bundledClosure([1, 6, 13, 18, 24]));
  // 12 per cable: strand 13 is the first fibre of cable 2, strand 18 the sixth, strand 24 the last.
  assert.strictEqual(rows.get(1).cable, 1);
  assert.strictEqual(rows.get(1).strandInCable, 1);
  assert.strictEqual(rows.get(1).address, 'T01-F01');
  assert.strictEqual(rows.get(1).label, 'C01/T01-F01', 'a bundled row is always cable-qualified');

  assert.strictEqual(rows.get(13).cable, 2);
  assert.strictEqual(rows.get(13).strandInCable, 1);
  assert.strictEqual(rows.get(13).address, 'T01-F01', 'one tube per cable: the tray address is in cable 2');
  assert.strictEqual(rows.get(13).label, 'C02/T01-F01');

  // The gh#95 case: strand 18 used to print T02-F06, a tube neither cable has.
  assert.strictEqual(rows.get(18).cable, 2);
  assert.strictEqual(rows.get(18).strandInCable, 6);
  assert.strictEqual(rows.get(18).address, 'T01-F06');
  assert.strictEqual(rows.get(18).label, 'C02/T01-F06');
  // Fibre 6 of a tube is white, and it was white before the fix too: only the cable/tube was missing.
  assert.strictEqual(rows.get(18).colour, 'white');

  assert.strictEqual(rows.get(24).label, 'C02/T01-F12');
  assert.strictEqual(rows.get(24).colour, 'aqua');
});

test('a single-cable span keeps the bare tray address and gains cable 1', function () {
  // One 48-fibre cable: strand 18 is tube 2, fibre 6 of *that* cable, and nothing is cable-qualified.
  const plant = bundledClosure([1, 18], 1);
  plant.spans[0].cable = 'g652d-loose-48';
  const rows = rowsByStrand(plant);
  assert.strictEqual(rows.get(18).cable, 1);
  assert.strictEqual(rows.get(18).strandInCable, 18);
  assert.strictEqual(rows.get(18).address, 'T02-F06', '18 fibres in one cable is tube 2, fibre 6');
  assert.strictEqual(rows.get(18).label, 'T02-F06', 'no C prefix when one cable runs the span');
});

test("a splitter's bundled tail is addressed per cable too", function () {
  const plant = {
    nodes: [
      { id: 'o1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 't1', type: 'closure', model: 'splitter-box-16' },
      { id: 'sp1', type: 'splitter', model: 'plc-1x8-sca', name: 'SPL 1:8' },
      { id: 'x1', type: 'ont', model: 'gpon-ont-4ge' }
    ],
    spans: [
      { id: 's1', from: 'o1', to: 't1', cable: 'g652d-loose-48', lengthM: 600, strands: [1] },
      { id: 's2', from: 't1', to: 'sp1', cable: BUNDLE, bundles: 2, lengthM: 1, purpose: 'splitter-tail', strands: [13, 24] },
      { id: 's3', from: 'sp1', to: 'x1', cable: 'g657a2-drop-1', lengthM: 40, strands: [1] }
    ]
  };
  const tail = engine.network.spliceTable(plant, registry).points
    .find(function (p) { return p.node === 'sp1'; }).rows
    .filter(function (r) { return r.span === 's2'; });
  assert.strictEqual(tail.length, 2);
  assert.deepStrictEqual(tail.map(function (r) { return r.strand; }), [13, 24]);
  assert.strictEqual(tail[0].via, 'splitter-input');
  assert.strictEqual(tail[0].label, 'C02/T01-F01');
  assert.strictEqual(tail[1].label, 'C02/T01-F12');
});

test('an unknown cable model has no cable dimension to print', function () {
  const plant = {
    nodes: [
      { id: 'c1', type: 'closure', model: 'mufa-inline-24' },
      { id: 'x1', type: 'ont', model: 'gpon-ont-4ge' }
    ],
    spans: [{ id: 's1', from: 'c1', to: 'x1', cable: 'not-a-cable', lengthM: 40, strands: [25] }]
  };
  const row = engine.network.spliceTable(plant, registry).points[0].rows[0];
  assert.strictEqual(row.address, 'T03-F01');
  assert.strictEqual(row.cable, null, 'a missing cable model stays missing rather than claiming cable 1');
  assert.strictEqual(row.strandInCable, 25);
  assert.strictEqual(row.label, 'T03-F01', 'nothing names a cable that is not known');
});

test('an index outside the bundle is refused, not labelled cable 3 of 2', function () {
  // 2 x 12 = 24 fibres; strand 25 is not in the bundle at all.
  throws(function () { engine.fiber.bundleAddressFor(25, 12, 2); }, 'bundle');
  throws(function () { engine.fiber.bundleAddressFor(0, 12, 2); }, 'strand index');
  // A known-good edge still works.
  assert.strictEqual(engine.fiber.bundleAddressFor(24, 12, 2).label, 'C02/T01-F12');
});

// The repro from gh#95: an auto-designed active tree on a 12-fibre ladder, 40 houses, 74 fibres over
// seven cables. Every row must resolve to a cable and a tray, and no two rows may share a label.
function bundledDesign() {
  const points = [];
  for (let i = 0; i < 40; i++) {
    points.push({ label: 'H' + i, lat: 51.5 + i * 0.0004, lon: -0.1 + Math.sin(i / 5) * 0.0009 });
  }
  const out = engine.design.synthesise(points, {
    headEnd: { lat: 51.499, lon: -0.1006 },
    technology: 'active',
    ladder: [BUNDLE]
  }, registry);
  assert.strictEqual(out.best.feasible, true, 'the design must be buildable: ' + out.best.warnings.join('; '));
  return out.plant;
}

test('every row of an auto-designed bundled span resolves to a cable and a tray', function () {
  const plant = bundledDesign();
  const span = plant.spans.filter(function (s) { return s.bundles > 1; })
    .sort(function (a, b) { return b.bundles - a.bundles; })[0];
  assert.ok(span, 'the estate must produce a bundled span, or this test proves nothing');
  const fiberCount = registry.get('cable', span.cable).fiberCount;
  const perTube = registry.get('cable', span.cable).fibersPerTube;

  const points = engine.network.spliceTable(plant, registry).points
    .map(function (p) { return { node: p.node, rows: p.rows.filter(function (r) { return r.span === span.id; }) }; })
    .filter(function (p) { return p.rows.length; });
  assert.ok(points.length > 0, 'the bundled span must reach a splice point');
  const rows = points[0].rows;
  assert.ok(rows.length >= span.strands.length, 'the sheet must carry a row per live fibre at each end');

  points.forEach(function (point) {
    const labels = new Set();
    point.rows.forEach(function (row) {
      // 74 fibres over 7 x 12: strand 74 is cable 7, fibre 2 (the gh#95 example, now resolvable).
      assert.strictEqual((row.cable - 1) * fiberCount + row.strandInCable, row.strand,
        'cable ' + row.cable + ' / fibre ' + row.strandInCable + ' must be strand ' + row.strand);
      assert.ok(row.cable >= 1 && row.cable <= span.bundles, 'cable ' + row.cable + ' of ' + span.bundles);
      assert.strictEqual(row.address, engine.fiber.addressFor(row.strandInCable, { fibersPerTube: perTube }).label);
      assert.strictEqual(row.label, 'C' + String(row.cable).padStart(2, '0') + '/' + row.address);
      labels.add(row.label);
    });
    assert.strictEqual(labels.size, point.rows.length,
      'two rows at ' + point.node + ' cannot name the same tray twice');
  });
  const at74 = rows.find(function (r) { return r.strand === 74; });
  assert.ok(at74, 'the estate must use strand 74');
  assert.strictEqual(at74.cable, 7);
  assert.strictEqual(at74.strandInCable, 2);
  assert.strictEqual(at74.label, 'C07/T01-F02', 'the gh#95 repro: tray T07-F02 does not exist in either cable');
});

done();
