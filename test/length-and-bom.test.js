'use strict';
// The number somebody spends money against.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const length = engine.length;

test('route + allowances, itemised', function () {
  const r = length.cableToBuy({ routeM: 192, overlengthPct: 3, splices: 1, spliceReserveM: 30, closures: 1, closureReserveM: 20, drumM: 2000 });
  // 192 + 5.76 + 30 + 20 = 247.76
  close(r.overlengthM, 5.76, 0.001, 'overlength');
  close(r.designM, 247.76, 0.001, 'design length');
  assert.strictEqual(r.drums, 1);
  assert.strictEqual(r.purchaseM, 2000);
  close(r.spareM, 1752.24, 0.001, 'spare');
  assert.strictEqual(r.lines.filter(function (l) { return l.total; }).length, 2, 'design and purchase are both totals');
});

test('drums round up, never down', function () {
  const r = length.cableToBuy({ routeM: 4100, overlengthPct: 0, splices: 0, closures: 0, drumM: 2000 });
  assert.strictEqual(r.designM, 4100);
  assert.strictEqual(r.drums, 3);
  assert.strictEqual(r.purchaseM, 6000);
});

test('a supplier minimum can push the purchase above the design', function () {
  const r = length.cableToBuy({ routeM: 100, drumM: 0, minimumPurchaseM: 500 });
  assert.strictEqual(r.purchaseM, 500);
  assert.ok(r.spareM > 0);
});

test('bad inputs are refused', function () {
  throws(function () { length.cableToBuy({}); }, 'routeM');
  throws(function () { length.cableToBuy({ routeM: -5 }); }, 'routeM');
  throws(function () { length.cableToBuy({ routeM: 10, splices: -1 }); }, 'splices');
  throws(function () { length.cableToBuy({ routeM: 10, overlengthPct: 'lots' }); }, 'overlengthPct');
});

test('a route drawn as points measures itself', function () {
  const points = [{ lat: 51.5, lon: -0.1 }, { lat: 51.501, lon: -0.1 }];
  const r = length.cableToBuyForRoute(points, { drumM: 0, overlengthPct: 0, splices: 0, closures: 0 });
  assert.ok(r.routeM > 110 && r.routeM < 112, 'one thousandth of a degree of latitude is about 111 m, got ' + r.routeM);
});

test('the BOM aggregates per cable model across spans', function () {
  const plant = {
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'n2', type: 'closure', model: 'nap-8' },
      { id: 'n3', type: 'ont', model: 'gpon-ont-1ge' }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 1000, splices: 1, closures: 1 },
      { id: 's2', from: 'n2', to: 'n3', cable: 'g652d-loose-24', lengthM: 100, splices: 0, closures: 0 }
    ]
  };
  const bom = length.billOfMaterials(plant, registry, { overlengthPct: 3, drumM: 2000 });
  assert.strictEqual(bom.lines.length, 2);
  assert.strictEqual(bom.byCable.length, 1, 'one cable model, one purchase line');
  // span 1: 1000 m + 3% (30) + one splice reserve (30) + one closure reserve (20) = 1080
  close(bom.lines[0].designM, 1080, 0.01, 'first span design length');
  // span 2: 100 m + 3% = 103
  close(bom.lines[1].designM, 103, 0.01, 'second span design length');
  // Drums are rounded once, on the total: 1183 m needs one 2000 m drum, not two.
  close(bom.byCable[0].designM, 1183, 0.01, 'aggregated design length');
  assert.strictEqual(bom.byCable[0].drums, 1);
  assert.strictEqual(bom.byCable[0].purchaseM, 2000);
  close(bom.byCable[0].spareM, 817, 0.01, 'spare on site');
});

test('a per-span line carries metres, never a drum count', function () {
  // Two short runs of the same cable. Rounding each span on its own buys a drum per span - the exact
  // bug the per-model round exists to prevent - and this line used to carry that second, contradictory
  // purchase: span A said "1 drum, 2000 m bought" and span B said the same, while the model line said
  // one drum in total. A span line is for tracing metres back to the map, so it reports metres only.
  const plant = {
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'n2', type: 'closure', model: 'nap-8' },
      { id: 'n3', type: 'ont', model: 'gpon-ont-1ge' }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 500 },
      { id: 's2', from: 'n2', to: 'n3', cable: 'g652d-loose-12', lengthM: 500 }
    ]
  };
  const bom = length.billOfMaterials(plant, registry, { overlengthPct: 0 });
  // 500 + 500 = 1000 m, one 2000 m drum.
  assert.strictEqual(bom.byCable[0].designM, 1000);
  assert.strictEqual(bom.byCable[0].drums, 1);
  assert.strictEqual(bom.byCable[0].purchaseM, 2000);
  for (const line of bom.lines) {
    close(line.designM, 500, 0.01, 'span ' + line.span + ' design length');
    assert.strictEqual(line.drums, undefined, 'span ' + line.span + ' must not report a drum count');
    assert.strictEqual(line.purchaseM, undefined, 'span ' + line.span + ' must not report a purchase');
    assert.strictEqual(line.spareM, undefined, 'span ' + line.span + ' must not report spare metres');
  }
});

test('a span with no measured length stops the BOM instead of buying zero metres', function () {
  throws(function () {
    length.billOfMaterials({ nodes: [], spans: [{ id: 's1', from: 'a', to: 'b', cable: 'g652d-loose-24' }] }, registry, {});
  }, 'no measured length');
});

test('a supplier minimum on a drum purchase is lifted to whole drums', function () {
  // 100 m of design against a 5000 m supplier minimum and 2000 m drums: two drums is 4000 m and misses
  // the minimum, so the smallest purchase that clears it is three drums = 6000 m. This used to report
  // `purchaseM: 5000` and a line reading "Purchase (1 x 2000 m drum)" - a label and a total that
  // disagree on what goes on the order. Cable is sold by the drum; a metre floor becomes a drum count.
  const r = length.cableToBuy({ routeM: 100, drumM: 2000, minimumPurchaseM: 5000 });
  assert.strictEqual(r.designM, 103);
  assert.strictEqual(r.drums, 3);
  assert.strictEqual(r.purchaseM, 6000);
  assert.strictEqual(r.purchaseM, r.drums * r.drumM, 'the purchase is a whole number of drums');
  const line = r.lines.filter(function (l) { return /^Purchase/.test(l.label); })[0];
  assert.strictEqual(line.m, r.purchaseM, 'the purchase line carries the purchase total');
  assert.ok(line.label.indexOf('3 x 2000') !== -1, 'the line names the drums it buys, got ' + line.label);
});

test('a minimum already met by whole drums changes nothing', function () {
  // 100 m needs one drum; 4500 m of design already needs three, which clears a 5000 m minimum? No:
  // 3 x 2000 = 6000 >= 5000, so the drum count stands. 2 x 2000 = 4000 would not have.
  const r = length.cableToBuy({ routeM: 4400, overlengthPct: 0, drumM: 2000, minimumPurchaseM: 5000 });
  assert.strictEqual(r.designM, 4400);
  assert.strictEqual(r.drums, 3);
  assert.strictEqual(r.purchaseM, 6000);
});

test('the BOM applies the supplier minimum to the per-cable purchase', function () {
  // billOfMaterials rounded its own drums and never read the minimum at all, so it quoted 2000 m to a
  // supplier whose floor is 5000 m - a purchase order that cannot be filled.
  const plant = {
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'n2', type: 'closure', model: 'nap-8' },
      { id: 'n3', type: 'ont', model: 'gpon-ont-1ge' }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 1000, splices: 1, closures: 1 },
      { id: 's2', from: 'n2', to: 'n3', cable: 'g652d-loose-24', lengthM: 100, splices: 0, closures: 0 }
    ]
  };
  const bom = length.billOfMaterials(plant, registry, { overlengthPct: 3, drumM: 2000, minimumPurchaseM: 5000 });
  close(bom.byCable[0].designM, 1183, 0.01, 'aggregated design length');
  assert.strictEqual(bom.byCable[0].drums, 3, 'the smallest whole-drum purchase that clears 5000 m');
  assert.strictEqual(bom.byCable[0].purchaseM, 6000);
  close(bom.byCable[0].spareM, 4817, 0.01, 'spare on site');
});

test('the calculation reports the minimum it applied', function () {
  // The result echoed the raw option, so a caller that left the minimum at its default read `undefined`
  // from a field describing a calculation that used 0.
  assert.strictEqual(length.cableToBuy({ routeM: 10, drumM: 0 }).minimumPurchaseM, 0);
  assert.strictEqual(length.cableToBuy({ routeM: 10, drumM: 0, minimumPurchaseM: 500 }).minimumPurchaseM, 500);
});

test('the BOM refuses a minimum that is not a number, even with no spans', function () {
  // The per-span call was the only place that validated the option, so an empty plant returned a
  // purchase that had never read it.
  throws(function () {
    length.billOfMaterials({ nodes: [], spans: [] }, registry, { minimumPurchaseM: 'lots' });
  }, 'minimumPurchaseM');
});

done();
