'use strict';
// The two figures a printed drawing has to carry honestly: how long the scale bar is in metres at
// the current projection, and how many metres one pixel of an exported PNG is. Both are arithmetic,
// so both are asserted here rather than trusted by eye on a screenshot.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');
const scene = require('../web/scene');

// ---------------------------------------------------------------- scale bar

test('a scale bar is a round number of metres that fits inside the asked width', function () {
  // 1 px = 0.5 m, 120 px available: 50 m is 100 px, 100 m would be 200 px and overflow.
  const bar = scene.scaleBar(0.5, 120);
  assert.strictEqual(bar.metres, 50);
  close(bar.pixels, 100, 1e-9, 'bar pixels');
  assert.strictEqual(bar.label, '50 m');
  assert.ok(bar.pixels <= 120, 'the bar must fit the space it was given');
});

test('the scale bar steps by 1-2-5 so it stays readable at every zoom', function () {
  // 1 px = 2.5 m: 200 m is 80 px, 500 m would be 200 px.
  const coarse = scene.scaleBar(2.5, 120);
  assert.strictEqual(coarse.metres, 200);
  // 1 px = 0.05 m: 5 m is 100 px, 10 m would be 200 px.
  const fine = scene.scaleBar(0.05, 120);
  assert.strictEqual(fine.metres, 5);
});

test('a scale bar without a scale is refused, never drawn as zero', function () {
  throws(function () { scene.scaleBar(0, 120); }, 'metresPerPixel');
  throws(function () { scene.scaleBar(-1, 120); }, 'metresPerPixel');
  throws(function () { scene.scaleBar(NaN, 120); }, 'metresPerPixel');
});

// ---------------------------------------------------------------- PNG export

test('a 2x export doubles the pixels and halves the metres each pixel covers', function () {
  const size = scene.exportPlan({ width: 900, height: 560, metresPerPixel: 0.5 }, 2);
  assert.strictEqual(size.width, 1800);
  assert.strictEqual(size.height, 1120);
  close(size.metresPerPixel, 0.25, 1e-9, 'metres per exported pixel');
  assert.ok(size.label.indexOf('0.25 m') !== -1, size.label);
  assert.ok(size.label.indexOf('2') !== -1, 'the label must state the zoom it was drawn at: ' + size.label);
});

test('a 1x export is the on-screen figure, unchanged', function () {
  const size = scene.exportPlan({ width: 900, height: 560, metresPerPixel: 0.8 }, 1);
  assert.strictEqual(size.width, 900);
  close(size.metresPerPixel, 0.8, 1e-9, 'metres per pixel at 1x');
});

test('an export with no projection or a bad zoom is refused, not guessed', function () {
  throws(function () { scene.exportPlan({ width: 900, height: 560 }, 2); }, 'metresPerPixel');
  throws(function () { scene.exportPlan({ width: 900, height: 560, metresPerPixel: 0.5 }, 0); }, 'zoom');
  throws(function () { scene.exportPlan({ width: 900, height: 560, metresPerPixel: 0.5 }, -2); }, 'zoom');
});

// ---------------------------------------------------------------- splice schedule

function plantWithStrands() {
  return {
    nodes: [
      { id: 'o1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'c1', type: 'closure', model: 'inline-closure-24' },
      { id: 'n1', type: 'ont', model: 'gpon-ont-4ge' }
    ],
    spans: [
      { id: 's1', from: 'o1', to: 'c1', cable: 'g652d-loose-12', lengthM: 800, strands: [1, 2, 3] },
      { id: 's2', from: 'c1', to: 'n1', cable: 'g657a2-drop-2', lengthM: 45, strands: [2, 3] }
    ]
  };
}

test('the splice schedule lists every strand at every splice point, with its TIA-598 address', function () {
  const table = engine.network.spliceTable(plantWithStrands(), engine.createRegistry());
  assert.strictEqual(table.points.length, 1, 'only the closure is a splice point; OLT and ONT terminate');
  const point = table.points[0];
  assert.strictEqual(point.node, 'c1');
  assert.strictEqual(point.spans.length, 2);
  // Strand 1 arrives on s1 only: it is parked, not spliced. Strands 2 and 3 continue into s2, and
  // each row names the span on the other side it is spliced to.
  const one = point.rows.find(function (r) { return r.span === 's1' && r.strand === 1; });
  assert.deepStrictEqual(one.splicedTo, []);
  const twoOnS1 = point.rows.find(function (r) { return r.span === 's1' && r.strand === 2; });
  assert.deepStrictEqual(twoOnS1.splicedTo, ['s2']);
  const twoOnS2 = point.rows.find(function (r) { return r.span === 's2' && r.strand === 2; });
  assert.deepStrictEqual(twoOnS2.splicedTo, ['s1']);
  // Strand 2 is TIA-598 orange; the address and the swatch come from the same table the engine
  // addresses the strand with.
  const address = engine.fiber.addressFor(2);
  assert.strictEqual(twoOnS1.address, address.label);
  assert.strictEqual(twoOnS1.colour, address.fiberColor.name);
  assert.strictEqual(twoOnS1.hex, address.fiberColor.hex);
});

test('a strand index that is not a positive integer is skipped, not allowed to kill the schedule', function () {
  const plant = plantWithStrands();
  plant.spans[0].strands = [0, 1.5, 'x', 3];
  plant.spans[1].strands = [3];
  const table = engine.network.spliceTable(plant, engine.createRegistry());
  assert.deepStrictEqual(table.points[0].rows.map(function (r) { return r.strand; }), [3, 3]);
});

test('a splitter is a splice point too, and a plant with no closures has an empty schedule', function () {
  const splitters = {
    nodes: [
      { id: 'o1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'sp1', type: 'splitter', model: 'plc-1x8-sca' },
      { id: 'n1', type: 'ont', model: 'gpon-ont-4ge' }
    ],
    spans: [
      { id: 's1', from: 'o1', to: 'sp1', cable: 'g652d-loose-12', lengthM: 500, strands: [1] },
      { id: 's2', from: 'sp1', to: 'n1', cable: 'g657a2-drop-1', lengthM: 40, strands: [1] }
    ]
  };
  const table = engine.network.spliceTable(splitters, engine.createRegistry());
  assert.strictEqual(table.points.length, 1);
  assert.strictEqual(table.points[0].type, 'splitter');
  assert.strictEqual(table.points[0].rows.length, 2);
  assert.deepStrictEqual(table.points[0].rows[0].splicedTo, ['s2']);

  const empty = engine.network.spliceTable({ nodes: [{ id: 'o1', type: 'olt' }], spans: [] }, engine.createRegistry());
  assert.deepStrictEqual(empty.points, []);
  assert.strictEqual(empty.totalStrands, 0);
});

done();
