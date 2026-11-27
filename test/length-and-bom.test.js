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

// A knob the calculation does not read is a typo, and this endpoint's answer is a purchase order,
// so a silently skipped option buys the wrong cable. Measured before this guard, on `routeM: 1000`:
//   `overlengthpct: 10` answered `designM` 1030 (the 3% default) - 70 m of the overlength the caller
//   named was missing from the order, and `drumm: 500` priced the 2000 m drum, so 2000 m were bought
//   where the caller asked for 3 x 500. The budget endpoints have refused a near-miss field since #137;
//   this is the same rule where the money is.
test('an option the calculation does not read is refused, not skipped', function () {
  throws(function () { length.cableToBuy({ routeM: 1000, overlengthpct: 10 }); },
    'did you mean "overlengthPct"', 'overlengthpct');
  throws(function () { length.cableToBuy({ routeM: 1000, drumm: 500 }); },
    'did you mean "drumM"', 'drumm');
  // Singular for plural: the 20 m reserve each closure carries was dropped, 40 m short on two.
  throws(function () { length.cableToBuy({ routeM: 1000, closure: 2 }); },
    'did you mean "closures"', 'closure');
  // A wrong unit is a near miss too: routeKM against routeM.
  throws(function () { length.cableToBuy({ routeM: 1000, routeKM: 1 }); },
    'did you mean "routeM"', 'routeKM');
  // A swapped adjacent pair is one keystroke, not two edits. `overlenghtPct: 10` on 1000 m was
  // answered with the 3% default, `designM` 1030 instead of 1100 - 70 m of the named slack missing
  // from the order, and the order is why this guard exists (#25, #27).
  throws(function () { length.cableToBuy({ routeM: 1000, overlenghtPct: 10 }); },
    'did you mean "overlengthPct"', 'overlenghtPct');
  const swapped = throws(function () { length.billOfMaterials({
    nodes: [{ id: 'n1', type: 'olt', model: 'gpon-c-plus-8' }, { id: 'n2', type: 'ont', model: 'gpon-ont-1ge' }],
    spans: [{ id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 1000, splices: 2 }]
  }, registry, { overlenghtPct: 10 }); }, 'did you mean "overlengthPct"', 'overlenghtPct on the BOM');
  assert.ok(swapped.message.indexOf('bill of materials') !== -1, swapped.message);
  // The refusal is narrow: a key that is not near a field the calculation reads is still ignored, so
  // a caller's own bookkeeping passes through. `name` and `notes` are the two the API documents.
  const r = length.cableToBuy({ routeM: 1000, name: 'Feeder A', notes: 'pulled 2026-11' });
  close(r.designM, 1030, 0.001, 'a bookkeeping key must not change the number');
});

test('a drawn route refuses a near-miss knob as well', function () {
  // Both forms end in `cableToBuy`, so a guard there covers the route form without a second list.
  const points = [{ lat: 51.5, lon: -0.1 }, { lat: 51.51, lon: -0.1 }];
  throws(function () { length.cableToBuyForRoute(points, { overlengthpct: 10 }); },
    'did you mean "overlengthPct"', 'route form');
});

test('a route drawn as points measures itself', function () {
  const points = [{ lat: 51.5, lon: -0.1 }, { lat: 51.501, lon: -0.1 }];
  const r = length.cableToBuyForRoute(points, { drumM: 0, overlengthPct: 0, splices: 0, closures: 0 });
  assert.ok(r.routeM > 110 && r.routeM < 112, 'one thousandth of a degree of latitude is about 111 m, got ' + r.routeM);
});

test('a route with no measurable length is refused, not priced at zero metres', function () {
  // Measured before this guard: `POST /api/design/length {"points":[]}` answered 200 with routeM 0,
  // designM 0, drums 0 and purchaseM 0 - a purchase order for nothing, from a caller who sent no
  // route at all. `billOfMaterials` already refuses a span with no measured length ("measure the
  // route before building a BOM"); the route form has no measured length either, and 0.00 m is not
  // the same answer as "nothing was drawn".
  throws(function () { length.cableToBuyForRoute([], {}); }, 'at least two', 'an empty route');
  throws(function () { length.cableToBuyForRoute([{ lat: 51.5, lon: -0.1 }], {}); }, 'at least two', 'a one-point route');
});

test('a route point that is not a coordinate is named by its index', function () {
  // An empty CSV/import cell is the classic case: `Number('')` is 0, and a point at 0,0 used to be
  // reached as a real coordinate. It is refused, but "distanceM needs two { lat, lon } coordinates"
  // names an internal function and neither the point nor the file - on a 40-point route that is a
  // hunt. The refusal names the position instead.
  const points = [{ lat: 51.5, lon: -0.1 }, { lat: 51.51, lon: -0.1 }, { lat: '', lon: '' }, { lat: 51.52, lon: -0.1 }];
  throws(function () { length.cableToBuyForRoute(points, {}); }, 'point 2', 'an empty cell in a route');
  throws(function () { length.cableToBuyForRoute([{ lat: 51.5, lon: -0.1 }, { lat: 95, lon: 0 }], {}); }, 'point 1', 'a latitude off the globe');
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

// The BOM reads five of the options the cable page does, and it used to hand them to `cableToBuy` in a
// fresh object with every key spelled correctly - so the guard one layer down never saw the caller's
// typo. Measured on `main` at c3ebcc3, one 1000 m span of g652d-loose-12 with two splices
// (`{}` -> designM 1090 = 1000 + 3% + 2 x 30):
//   `{"overlengthpct": 10}`      bought 1090 m - the 3% default, 70 m of the named slack missing;
//   `{"minimumPurchase": 5000}`  bought 2000 m - one drum against a 5000 m supplier floor;
//   `{"spliceReserves": 5}`      dropped both 30 m reserves, 60 m short.
// The answer is a purchase order, so a near miss is refused by name here too, in metres rather than in
// loss: the refusal says the BOM does not read the option, not the field.
test('a BOM option the calculation does not read is refused, not silently dropped', function () {
  const plant = {
    nodes: [{ id: 'n1', type: 'olt', model: 'gpon-c-plus-8' }, { id: 'n2', type: 'ont', model: 'gpon-ont-1ge' }],
    spans: [{ id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 1000, splices: 2 }]
  };
  // The fixture is the measured one: 1000 + 30 (3%) + 2 x 30 = 1090 m.
  assert.strictEqual(length.billOfMaterials(plant, registry, {}).byCable[0].designM, 1090);
  throws(function () { length.billOfMaterials(plant, registry, { overlengthpct: 10 }); },
    'did you mean "overlengthPct"', 'overlengthpct');
  throws(function () { length.billOfMaterials(plant, registry, { minimumPurchase: 5000 }); },
    'did you mean "minimumPurchaseM"', 'minimumPurchase');
  throws(function () { length.billOfMaterials(plant, registry, { spliceReserves: 5 }); },
    'did you mean "spliceReserveM"', 'spliceReserves');
  throws(function () { length.billOfMaterials(plant, registry, { closureReserve: 5 }); },
    'did you mean "closureReserveM"', 'closureReserve');
  throws(function () { length.billOfMaterials(plant, registry, { drumm: 500 }); },
    'did you mean "drumM"', 'drumm');
  // Narrow, as everywhere else: a key that is not near a field the BOM reads is the caller's own
  // bookkeeping and still passes, and the correctly spelled option still applies.
  const bom = length.billOfMaterials(plant, registry, { name: 'Feeder A', note: 'pulled 2026-11' });
  assert.strictEqual(bom.byCable[0].designM, 1090, 'a bookkeeping key must not change the number');
  assert.strictEqual(length.billOfMaterials(plant, registry, { overlengthPct: 10 }).byCable[0].designM, 1160,
    '1000 + 10% (100) + 2 x 30 = 1160 m');
});

// A cable that states no drum, measured on this engine (two indoor-24 spans, 1200 m + 900 m,
// overlengthPct 3) before the fix: the by-model row answered `drumM: 0, drums: 0, purchaseM: 2163`
// - "bought by the metre", because the row read `cable.drumM || o.drumM || 0` and turned "not stated
// anywhere" into 0 - while the span calculation inside the same call had used the 2000 m default and
// `cableToBuy` on the same total buys two drums (4000 m). g657a2-indoor-24 and -48 publish no drumM
// on purpose, and their notes promise the BOM "falls back to engine/length.js's 2,000 m default and
// prints it", so the row must report the drum the purchase used, not a zero that buys by the metre.
test('a cable that states no drum buys the engine default, and the row names that drum', function () {
  const plant = {
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'n2', type: 'closure', model: 'nap-8' },
      { id: 'n3', type: 'ont', model: 'gpon-ont-1ge' }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n2', cable: 'g657a2-indoor-24', lengthM: 1200 },
      { id: 's2', from: 'n2', to: 'n3', cable: 'g657a2-indoor-24', lengthM: 900 }
    ]
  };
  const bom = length.billOfMaterials(plant, registry, { overlengthPct: 3 });
  const row = bom.byCable[0];
  // 1200 + 900 = 2100 m, + 3% = 2163 m -> two 2000 m drums, 4000 m bought, 1837 m spare.
  close(row.designM, 2163, 0.01, '2100 m + 3%');
  assert.strictEqual(row.drumM, 2000, 'the engine default drum is the one the purchase used');
  assert.strictEqual(row.drums, 2);
  assert.strictEqual(row.purchaseM, 4000);
  close(row.spareM, 1837, 0.01, '4000 - 2163');
  assert.strictEqual(row.purchaseM, row.drums * row.drumM, 'a whole number of the drums it names');
  // The single-route calculation on the same total must agree with the aggregated row, or the BOM
  // and the design cost (which buys `purchaseM`) describe two different orders.
  const oneShot = length.cableToBuy({ routeM: 2163, overlengthPct: 0 });
  assert.strictEqual(oneShot.drums, row.drums, 'one route and the aggregate buy the same drums');
  assert.strictEqual(oneShot.purchaseM, row.purchaseM);
  // An explicit 0 from the caller still means a cut reel, and the fallback must not overwrite it.
  const cut = length.billOfMaterials(plant, registry, { overlengthPct: 3, drumM: 0 });
  assert.strictEqual(cut.byCable[0].drumM, 0, 'a caller who says 0 means by the metre');
  assert.strictEqual(cut.byCable[0].drums, 0);
  close(cut.byCable[0].purchaseM, 2163, 0.01, 'bought by the metre is the design length');
});

test('the cable decides the drum, and a caller drumM is only a fallback', function () {
  // `cable.drumM || o.drumM`: the drum is a property of the cable, because buying 500 m drums of a
  // 288-fibre ribbon is a product nobody sells. A cable that states one is not overridable by a
  // caller's `drumM` - that precedence is deliberate and pinned here rather than quietly flipped,
  // because flipping it would let a body restate a drum the cable forbids. The two indoor rows
  // state none on purpose; there the caller's `drumM` (then the engine default) decides, which is
  // the case the test above pins.
  const plant = {
    nodes: [{ id: 'n1', type: 'olt', model: 'gpon-c-plus-8' }, { id: 'n2', type: 'ont', model: 'gpon-ont-1ge' }],
    spans: [{ id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 1000 }]
  };
  const bom = length.billOfMaterials(plant, registry, { overlengthPct: 0, drumM: 500 });
  assert.strictEqual(bom.byCable[0].drumM, 2000, 'the cable states a 2000 m drum');
  assert.strictEqual(bom.byCable[0].drums, 1, 'one 2000 m drum, not four 500 m ones');
  assert.strictEqual(bom.byCable[0].purchaseM, 2000);
});

test('a span that needs two cables buys both of them', function () {
  // 160 customer fibres do not fit one 144-fibre cable, so auto-design marks the span `bundles: 2`.
  // Two 1200 m cables is 2400 m of cable; +3% overlength = 2472 m, which is two 2000 m drums
  // (4000 m bought). The BOM read the span's map length once, so the order was 1236 m / one drum -
  // half the cable for a span whose strands cannot fit the one cable it priced.
  const plant = {
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'n2', type: 'closure', model: 'nap-8' },
      { id: 'n3', type: 'ont', model: 'gpon-ont-1ge' }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-144', lengthM: 1200, bundles: 2 },
      { id: 's2', from: 'n2', to: 'n3', cable: 'g657a2-drop-1', lengthM: 40 }
    ]
  };
  const bom = length.billOfMaterials(plant, registry, { overlengthPct: 3 });
  const trunk = bom.byCable.filter(function (r) { return r.model === 'g652d-loose-144'; })[0];
  close(trunk.designM, 2472, 0.01, 'two 1200 m cables + 3%');
  assert.strictEqual(trunk.drums, 2);
  assert.strictEqual(trunk.purchaseM, 4000);
  const line = bom.lines.filter(function (l) { return l.span === 's1'; })[0];
  assert.strictEqual(line.bundles, 2);
  assert.strictEqual(line.routeM, 1200, 'the span line still traces the measured route');
  close(line.designM, 2472, 0.01, 'the span line buys both cables');
});

test('a span with no bundles field is one cable, as it always was', function () {
  const plant = {
    nodes: [{ id: 'n1', type: 'olt', model: 'gpon-c-plus-8' }, { id: 'n2', type: 'ont', model: 'gpon-ont-1ge' }],
    spans: [{ id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 1000 }]
  };
  const bom = length.billOfMaterials(plant, registry, { overlengthPct: 3 });
  assert.strictEqual(bom.lines[0].bundles, 1);
  close(bom.lines[0].designM, 1030, 0.01, '1000 m + 3%');
});

test('a bundles count that is not a positive whole number is refused by name', function () {
  // Zero would buy no cable for a span that is drawn on the map, and 1.5 is not a cable count.
  // The refusal names the span and the value, the way splices and closures do.
  const plant = {
    nodes: [{ id: 'n1', type: 'olt', model: 'gpon-c-plus-8' }, { id: 'n2', type: 'ont', model: 'gpon-ont-1ge' }],
    spans: [{ id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 1000 }]
  };
  [0, -1, 1.5, '2', null].forEach(function (bad) {
    plant.spans[0].bundles = bad;
    const err = throws(function () { length.billOfMaterials(plant, registry, {}); }, 'invalid bundles count', 'bundles ' + String(bad));
    assert.ok(err.message.indexOf('s1') !== -1, 'the refusal names the span: ' + err.message);
  });
});

test('the design BOM and the cable page buy the same cable for one plant', function () {
  // One plant, one cable order. `synthesise` counts a span's bundles in its own BOM (fibre-metres and
  // cableM), and /bom prices the same span from the same plant - so the two lines have to agree. They
  // did not: 80 customers x 2 fibres put 160 fibres on the first tree edges, two 144-fibre cables per
  // span, and the cable page quoted half the cable the design had just ranked.
  const demand = [];
  for (let i = 1; i <= 80; i++) demand.push({ id: 'p' + i, label: 'H' + i, lat: 0, lon: i * 0.0002 });
  const out = engine.design.synthesise(demand, {
    headEnd: { lat: 0, lon: 0, name: 'HE' }, technology: 'active', includeAllPlants: true
  }, registry);
  const tree = out.candidates.filter(function (c) { return c.label.indexOf('shared cable tree') !== -1; })[0];
  assert.ok(tree && tree.plant, 'the active tree candidate should carry a plant');
  assert.ok(tree.plant.spans.some(function (s) { return (s.bundles || 1) > 1; }),
    'the fixture must need a bundled span or this test proves nothing');
  const bom = length.billOfMaterials(tree.plant, registry, {});
  const byModel = new Map(bom.byCable.map(function (r) { return [r.model, r]; }));
  tree.bom.lines.forEach(function (line) {
    const row = byModel.get(line.model);
    assert.ok(row, 'the cable page is missing ' + line.model);
    // Per-span rounding of the 3% overlength moves the sum by under a metre; the bug was a factor.
    close(row.designM, line.designM, 2, line.model + ' design length');
    assert.strictEqual(row.drums, line.drums, line.model + ' drums');
  });
});

test('the answer echoes the reserve RATE it read, and names the totals apart', function () {
  // `spliceReserveM` and `closureReserveM` are per-unit rates a caller sets (30 m a splice, 20 m a
  // closure). The answer put the *totals* back under those same names - 2 x 30 = 60 under
  // `spliceReserveM` - so reading the answer and sending it back doubled every reserve: 1000 m with
  // 2 splices and 3 closures answered designM 1150, and re-sending that answer answered 1330. 150 m
  // of cable difference is a drum decision on a 1900 m run, and the reader has no way to tell which
  // meaning of the name they got. The rate is echoed under the name the request used; the totals
  // carry their own names, the way `overlengthPct` (rate) and `overlengthM` (total) already did.
  const r = length.cableToBuy({ routeM: 1000, splices: 2, closures: 3 });
  assert.strictEqual(r.spliceReserveM, 30, 'the per-splice rate it read, not the total');
  assert.strictEqual(r.spliceReserveTotalM, 60, '2 splices x 30 m');
  assert.strictEqual(r.closureReserveM, 20, 'the per-closure rate it read');
  assert.strictEqual(r.closureReserveTotalM, 60, '3 closures x 20 m');
  // 1000 + 3% (30) + 60 + 60 = 1150
  close(r.designM, 1150, 0.01, 'route + overlength + both reserve totals');
  const again = length.cableToBuy({
    routeM: r.routeM,
    overlengthPct: r.overlengthPct,
    splices: r.splices,
    spliceReserveM: r.spliceReserveM,
    closures: r.closures,
    closureReserveM: r.closureReserveM,
    drumM: r.drumM
  });
  close(again.designM, r.designM, 0.01, 'the answer can be sent back unchanged');
});

done();
