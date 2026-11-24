'use strict';
// Overbooking a cable is the mistake that reaches site as a real, unusable drum.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

function plantWith(strands) {
  return {
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'n2', type: 'closure', model: 'nap-8' }
    ],
    spans: [{ id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 500, strands: strands }]
  };
}

test('a span with no strands assigned carries none', function () {
  const ledger = engine.network.strandLedger(plantWith(undefined), registry);
  assert.strictEqual(ledger.rows[0].used, 0);
  assert.strictEqual(ledger.rows[0].spare, 12);
  assert.strictEqual(ledger.rows[0].utilisation, 0);
  assert.strictEqual(ledger.overbooked, 0);
});

test('used and spare add up to the cable', function () {
  const ledger = engine.network.strandLedger(plantWith([1, 2, 3, 7]), registry);
  assert.strictEqual(ledger.rows[0].used, 4);
  assert.strictEqual(ledger.rows[0].spare, 8);
  assert.strictEqual(ledger.rows[0].utilisation, 33.3);
});

test('a repeated strand is one strand, not two', function () {
  const ledger = engine.network.strandLedger(plantWith([1, 1, 2]), registry);
  assert.strictEqual(ledger.rows[0].used, 2);
});

test('overbooking is reported per span and in the total', function () {
  const ledger = engine.network.strandLedger(plantWith([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]), registry);
  assert.strictEqual(ledger.rows[0].overbooked, true);
  assert.ok(ledger.rows[0].error.indexOf('14 strands of a 12-fibre cable') !== -1, ledger.rows[0].error);
  assert.strictEqual(ledger.overbooked, 1);
});

test('a span naming a cable the catalogue does not have still reports usage', function () {
  const plant = plantWith([1, 2]);
  plant.spans[0].cable = 'not-a-cable';
  const ledger = engine.network.strandLedger(plant, registry);
  assert.strictEqual(ledger.rows[0].fiberCount, null);
  assert.strictEqual(ledger.rows[0].used, 2);
  assert.strictEqual(ledger.rows[0].spare, null);
});

test('a bundled span has every cable\'s strands, so 18 of 24 is half full', function () {
  // Auto-design writes `bundles: 2` for a span that needs more fibres than one cable carries. The
  // ledger counted one cable: 18 strands on a 2 x 12 span read as overbooked, and 12 in use read as
  // 100% full with no spare even though a whole second cable was on the order.
  const plant = plantWith([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  plant.spans[0].bundles = 2;
  const ledger = engine.network.strandLedger(plant, registry);
  assert.strictEqual(ledger.rows[0].bundles, 2);
  assert.strictEqual(ledger.rows[0].used, 18);
  assert.strictEqual(ledger.rows[0].spare, 6);
  assert.strictEqual(ledger.rows[0].utilisation, 75);
  assert.strictEqual(ledger.rows[0].overbooked, false, '18 strands fit two 12-fibre cables');
  assert.strictEqual(ledger.totalStrands, 24, 'the total counts both cables');
  assert.strictEqual(ledger.totalUsed, 18);
  assert.strictEqual(ledger.utilisation, 75);
});

test('overbooking on a bundled span names both cables', function () {
  // 25 strands do not fit 2 x 12. The message has to say which capacity it exceeded, or a planner
  // reads "25 of a 12-fibre cable" and buys one cable instead of two.
  const plant = plantWith([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  plant.spans[0].bundles = 2;
  const ledger = engine.network.strandLedger(plant, registry);
  assert.strictEqual(ledger.rows[0].overbooked, true);
  assert.ok(/25 strands of 2 x 12-fibre cable/.test(ledger.rows[0].error), ledger.rows[0].error);
});

done();
