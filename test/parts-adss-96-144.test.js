'use strict';
// The aerial family stops at 48F in parts/cable/g652d-adss-* until now, and that row already cites
// the Corning sheet line "single-layer stranded construction up to 144 fibers" as proof the larger
// sizes are parts the vendor stocks. They were not rows, so a 96- or 144-fibre pole-route span had
// only g652d-loose-96/144 or g652d-ribbon-96/144 to name - gel-filled duct cable with no
// self-supporting strength member - and the BOM bought a product the route cannot take.
// The two rows are Corning 096ELE-T3322A20 and 144ELE-T3322A20 (EMEA ecatalog spec sheets, revision
// date 2026-11-28), and this suite is the driven evidence for their notes.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

// The duct and ribbon rungs a caller stocking no aerial cable has, richest first.
const DUCT = ['g652d-ribbon-144', 'g652d-ribbon-96', 'g652d-loose-144', 'g652d-loose-96', 'g652d-loose-48'];
const AERIAL = DUCT.concat(['g652d-adss-144', 'g652d-adss-96']);

test('the catalogue carries the 96F and 144F aerial rungs the 48F row cited', function () {
  const s96 = registry.get('cable', 'g652d-adss-96');
  const s144 = registry.get('cable', 'g652d-adss-144');
  assert.strictEqual(s96.fiberCount, 96);
  assert.strictEqual(s144.fiberCount, 144);
  // 8 x 12 and 12 x 12 on the two sheets; a 12-fibre tube is what every rung of the family uses.
  assert.strictEqual(s96.fibersPerTube, 12);
  assert.strictEqual(s144.fibersPerTube, 12);
  assert.strictEqual(s96.fiberStandard, 'G.652.D');
  assert.deepStrictEqual(s96.use, ['feeder']);
  assert.deepStrictEqual(s144.use, ['feeder']);
  // The sheet publishes MAXIMUM 0.36 / 0.36 / 0.22 at 1310 / 1383 / 1550 and no 1490 figure; the
  // rows carry the family typical row, 1490 interpolated, exactly as g652d-adss-12/24/48 do.
  assert.deepStrictEqual(s96.attenuationDbPerKm, { '1310': 0.35, '1490': 0.22, '1550': 0.21 });
  assert.deepStrictEqual(s144.attenuationDbPerKm, { '1310': 0.35, '1490': 0.22, '1550': 0.21 });
  // No drumM is the family decision: 6000 m is the sheet reel ceiling, not a putup, and the BOM
  // then rounds on the engine default rather than buying a 6 km reel for a short span.
  assert.strictEqual(s96.drumM, undefined, 'the 96F row publishes no drum: ' + s96.drumM);
  assert.strictEqual(s144.drumM, undefined, 'the 144F row publishes no drum: ' + s144.drumM);
  assert.ok(s96.sourceUrl.indexOf('096ELE-T3322A20') !== -1, s96.sourceUrl);
  assert.ok(s144.sourceUrl.indexOf('144ELE-T3322A20') !== -1, s144.sourceUrl);
});

test('a 96-fibre span leaves the gel-filled duct cable once the aerial rung is stocked', function () {
  // 1,200 m is a pole-to-pole run, far over DROP_CABLE_MAX_M (300), so the drop rule cannot apply
  // and cableFor takes the SMALLEST rung that carries 96 fibres.
  assert.strictEqual(engine.design.cableForSpan(96, 1200, DUCT, registry).model, 'g652d-loose-96',
    'duct ladder bought ' + engine.design.cableForSpan(96, 1200, DUCT, registry).model);
  // Both 96-fibre rungs fit; the tie breaks on model id and g652d-adss-96 sorts first. That is the
  // tie-break trap the row notes: name the aerial rung instead of its duct twin, not beside it.
  assert.strictEqual(engine.design.cableForSpan(96, 1200, AERIAL, registry).model, 'g652d-adss-96',
    'aerial ladder bought ' + engine.design.cableForSpan(96, 1200, AERIAL, registry).model);
  assert.strictEqual(engine.design.cableForSpan(96, 250, AERIAL, registry).model, 'g652d-adss-96',
    'a 96-fibre span is a cable run at any length: over two fibres, only a catalogued drop rung is taken');
});

test('a 144-fibre span takes the aerial trunk, and a 120-fibre span does too', function () {
  assert.strictEqual(engine.design.cableForSpan(144, 1200, DUCT, registry).model, 'g652d-loose-144',
    'duct ladder bought ' + engine.design.cableForSpan(144, 1200, DUCT, registry).model);
  assert.strictEqual(engine.design.cableForSpan(144, 1200, AERIAL, registry).model, 'g652d-adss-144');
  // 120 strands is not a rung: the smallest cable that carries it is 144, aerial or not.
  assert.strictEqual(engine.design.cableForSpan(120, 1200, AERIAL, registry).model, 'g652d-adss-144');
  // The family below the new rungs is unchanged: 48F still leaves both listings on the duct 48.
  assert.strictEqual(engine.design.cableForSpan(48, 1200, AERIAL, registry).model, 'g652d-loose-48',
    'AERIAL names no 48F rung, so 48 fibres still take the ladder floor');
});

test('an aerial trunk bills on the 2 km engine default, not the 6 km reel ceiling', function () {
  // 1,200 m x 1.03 overlength = 1,236 m; one 2,000 m drum covers it (764 m spare). With drumM 6000
  // taken from the sheet reel ceiling the same route would bill 6,000 m.
  const plant = {
    name: 'Aerial trunk',
    nodes: [
      { id: 'olt', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'c1', type: 'closure', model: 'fosc-600c-inline-288', name: 'Joint' }
    ],
    spans: [
      { id: 's1', from: 'olt', to: 'c1', cable: 'g652d-adss-144', lengthM: 1200 },
      { id: 's2', from: 'c1', to: 'olt', cable: 'g652d-adss-96', lengthM: 1200 }
    ]
  };
  const bom = engine.length.billOfMaterials(plant, registry);
  for (const model of ['g652d-adss-144', 'g652d-adss-96']) {
    const row = bom.byCable.filter(function (r) { return r.model === model; })[0];
    assert.ok(row, model + ' reaches the BOM');
    assert.strictEqual(row.designM, 1236, model + ' design metres: 1200 x 1.03');
    assert.strictEqual(row.drumM, 2000, model + ' drum length is the engine default');
    assert.strictEqual(row.drums, 1, model + ': one 2000 m drum covers 1236 m');
    assert.strictEqual(row.purchaseM, 2000, model + ' purchase is one whole drum');
  }
});

test('a 48-house active tree on the real catalogue buys the aerial rungs', function () {
  // The rung has to be reached by a design, not only by cableForSpan: 48 houses on an 8 x 6 grid,
  // two strands per ONT, ladder stocking the aerial rungs above the duct 24. Measured: 7 of the
  // spans take an ADSS rung, and the 1,334.3 m trunk carrying 96 strands is g652d-adss-96.
  const ladder = ['g652d-adss-144', 'g652d-adss-96', 'g652d-adss-48', 'g652d-loose-24', 'g652d-loose-12',
    'g657a2-drop-2', 'g657a2-drop-1'];
  const points = [];
  for (let i = 0; i < 48; i++) {
    points.push({ label: 'H' + (i + 1), lat: 51.5 + Math.floor(i / 8) * 0.0008, lon: -0.1 + (i % 8) * 0.001 });
  }
  const out = engine.design.synthesise(points, {
    headEnd: { lat: 51.49, lon: -0.1 }, technology: 'active', ladder: ladder, includeAllPlants: true
  }, registry);
  assert.ok(out.ok, 'the 48-house estate is feasible');
  const tree = out.candidates.filter(function (c) { return c.technology === 'active-tree' && c.feasible; })[0];
  assert.ok(tree, 'an active-tree candidate');
  const aerial = tree.plant.spans.filter(function (s) { return s.cable.indexOf('g652d-adss-') === 0; });
  assert.strictEqual(aerial.length, 7, 'aerial spans: ' +
    JSON.stringify(tree.plant.spans.map(function (s) { return [s.lengthM, s.strands.length, s.cable]; })));
  const trunk = tree.plant.spans.filter(function (s) { return s.strands.length === 96; })[0];
  assert.ok(trunk, 'a 96-strand span');
  assert.strictEqual(trunk.cable, 'g652d-adss-96', 'the 96-strand trunk bought ' + trunk.cable);
  assert.strictEqual(trunk.lengthM, 1334.3, 'trunk length measured at 1334.3 m: ' + trunk.lengthM);
});

done();
