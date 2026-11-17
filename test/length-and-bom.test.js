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

test('a span with no measured length stops the BOM instead of buying zero metres', function () {
  throws(function () {
    length.billOfMaterials({ nodes: [], spans: [{ id: 's1', from: 'a', to: 'b', cable: 'g652d-loose-24' }] }, registry, {});
  }, 'no measured length');
});

done();
