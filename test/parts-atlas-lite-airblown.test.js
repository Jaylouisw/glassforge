'use strict';
// Duct routing is a first-class path in this planner (engine/street.js routes over an imported duct
// graph), but the only cable a duct route could buy was an outdoor loose-tube on a 2 km drum: the
// catalogue had no air-blown micro-cable, which is the product that actually goes into a microduct and
// the one that arrives on a 4 km spool. Rows: STL Atlas Lite Air Blown 12F (2.3 mm, G.652.D / G.657.A1
// / G.657.A2 on order; this row prices A2) and 24F 200 um (G.657.A1 / A2), product specification
// rev 1.0, 23-Mar-2020: both publish a 4 km standard length multiple and a maximum cabled attenuation
// of 0.35 dB/km at 1310 nm and 0.23 dB/km at 1550 nm - and no 1490 nm figure.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const BLOWN_12 = 'atlas-lite-airblown-12';
const BLOWN_24 = 'atlas-lite-airblown-24';

test('the duct family is a blown micro-cable on a 4 km spool, 12F and 24F', function () {
  const twelve = registry.get('cable', BLOWN_12);
  const twentyFour = registry.get('cable', BLOWN_24);
  assert.strictEqual(twelve.fiberCount, 12);
  assert.strictEqual(twentyFour.fiberCount, 24);
  // One gel-filled unitube per cable: the sheet prints one 2.3 mm tube for 12F and one 2.5 mm tube for
  // the 24F build, so fibersPerTube is the installed count, not a 12-fibre grouping.
  assert.strictEqual(twelve.fibersPerTube, 12);
  assert.strictEqual(twentyFour.fibersPerTube, 24);
  assert.strictEqual(twelve.construction, 'loose-tube');
  assert.strictEqual(twentyFour.construction, 'loose-tube');
  assert.strictEqual(twelve.fiberStandard, 'G.657.A2');
  assert.strictEqual(twentyFour.fiberStandard, 'G.657.A2');
  // Blown into duct, not hung from a pole and not a drop: `use` carries no drop, so
  // cableForDistribution never pulls it onto a 60 m house span.
  assert.deepStrictEqual(twelve.use, ['distribution']);
  assert.deepStrictEqual(twentyFour.use, ['feeder', 'distribution']);
  // The sheet's "Standard Length Multiple (km): 4", for both counts.
  assert.strictEqual(twelve.drumM, 4000, 'a 4 km spool: ' + twelve.drumM);
  assert.strictEqual(twentyFour.drumM, 4000, 'a 4 km spool: ' + twentyFour.drumM);
  assert.ok(twelve.sourceUrl.indexOf('stl.tech') !== -1, twelve.sourceUrl);
  assert.ok(twentyFour.sourceUrl.indexOf('stl.tech') !== -1, twentyFour.sourceUrl);
});

test('the rows carry the sheet maxima, and 1490 nm is an interpolation that says so', function () {
  // 0.35 and 0.23 are the maxima at 1310 and 1550 nm, not typicals - a blown 200 um cable is budgeted
  // worst case here. 1490 nm is published by neither window, so it is the straight line between them:
  // 0.23 + (0.35 - 0.23) x (1550 - 1490) / (1550 - 1310) = 0.23 + 0.12 x 0.25 = 0.26.
  for (const model of [BLOWN_12, BLOWN_24]) {
    assert.deepStrictEqual(registry.get('cable', model).attenuationDbPerKm,
      { '1310': 0.35, '1490': 0.26, '1550': 0.23 }, model);
  }
});

test('a kilometre of blown cable budgets at the row attenuation, 1490 down and 1310 up', function () {
  const spans = [{ cable: BLOWN_24, lengthM: 1000 }];
  const down = engine.budget.opticalBudget({
    olt: { model: 'gpon-b-plus-8' }, ont: { model: 'gpon-ont-1ge' },
    direction: 'down', spans: spans, splices: 0, connectors: 0
  }, registry);
  assert.strictEqual(down.odnLossDb, 0.26, '1.0 km x 0.26 dB/km at 1490 nm');
  assert.strictEqual(down.wavelength, '1490');
  const up = engine.budget.opticalBudget({
    olt: { model: 'gpon-b-plus-8' }, ont: { model: 'gpon-ont-1ge' },
    direction: 'up', spans: spans, splices: 0, connectors: 0
  }, registry);
  assert.strictEqual(up.odnLossDb, 0.35, '1.0 km x 0.35 dB/km at 1310 nm');
  // An RF overlay is budgeted at 1550: the row publishes it, so the down direction does not throw.
  const overlay = engine.budget.opticalBudget({
    olt: { model: 'gpon-b-plus-8' }, ont: { model: 'gpon-ont-1ge' },
    direction: 'down', wavelength: '1550', spans: spans, splices: 0, connectors: 0
  }, registry);
  assert.strictEqual(overlay.odnLossDb, 0.23, '1.0 km x 0.23 dB/km at 1550 nm');
});

test('a 4 km spool rounds once per model - and can buy more than 2 km drums on a just-over run', function () {
  // 3.8 km + 3% = 3,914 m of design length: one 4 km spool, 86 m spare. The drum is the cable's own
  // (`parts/cable/*.json` drumM), which is why a 4 km row must be billed through its model and not
  // through cableToBuy's 2,000 m default.
  const shortRows = engine.length.billOfMaterials({
    spans: [{ id: 'duct', cable: BLOWN_12, lengthM: 3800, splices: 0, closures: 0 }]
  }, registry, { overlengthPct: 3 }).byCable[0];
  assert.strictEqual(shortRows.designM, 3914);
  assert.strictEqual(shortRows.drumM, 4000, 'the row drum, not the 2,000 m default: ' + shortRows.drumM);
  assert.strictEqual(shortRows.drums, 1);
  assert.strictEqual(shortRows.purchaseM, 4000);
  assert.strictEqual(shortRows.spareM, 86);

  // The same 5.5 km duct run (+3% = 5,665 m) buys 2 x 4 km = 8,000 m of blown cable, where the 2 km
  // outdoor drum buys 3 x 2 km = 6,000 m: a 4 km spool is not a discount on every route, and the BOM
  // is the place that shows it.
  const blown = engine.length.billOfMaterials({
    spans: [{ id: 'duct', cable: BLOWN_24, lengthM: 5500, splices: 0, closures: 0 }]
  }, registry, { overlengthPct: 3 });
  assert.strictEqual(blown.byCable[0].designM, 5665);
  assert.strictEqual(blown.byCable[0].drums, 2);
  assert.strictEqual(blown.byCable[0].purchaseM, 8000);
  const loose = engine.length.billOfMaterials({
    spans: [{ id: 'duct', cable: 'g652d-loose-24', lengthM: 5500, splices: 0, closures: 0 }]
  }, registry, { overlengthPct: 3 });
  assert.strictEqual(loose.byCable[0].drums, 3);
  assert.strictEqual(loose.byCable[0].purchaseM, 6000);
});

test('the default ladder bills no duct cable: an auto-designed outdoor estate is unchanged', function () {
  const demand = [
    { id: 'a', lat: 51.5009, lon: -0.1, model: 'gpon-ont-1ge' },
    { id: 'b', lat: 51.5011, lon: -0.0999, model: 'gpon-ont-1ge' }
  ];
  const out = engine.design.synthesise(demand, {
    technology: 'pon', routeFactor: 1,
    headEnd: { id: 'he', lat: 51.5, lon: -0.1 },
    pon: { ratios: [8], olt: 'gpon-b-plus-8', ont: 'gpon-ont-1ge' }
  }, registry);
  const billed = [];
  for (const candidate of out.candidates) {
    for (const line of (candidate.bom && candidate.bom.lines) || []) {
      if (line.model) billed.push(line.model);
    }
  }
  assert.ok(billed.length > 0, 'the estate designed nothing - the assertion would pass on an empty BOM');
  assert.ok(billed.indexOf(BLOWN_12) === -1, 'default ladder billed ' + BLOWN_12);
  assert.ok(billed.indexOf(BLOWN_24) === -1, 'default ladder billed ' + BLOWN_24);
});

done();
