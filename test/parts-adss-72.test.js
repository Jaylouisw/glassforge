'use strict';
// The aerial family shipped 12/24/48 (gh#147) and then 96/144 (gh#173), so the rungs skip 72 and
// cableFor's smallest-that-fits rule has no aerial answer between 48 and 96 fibres: a 49-72 fibre
// pole span was bought as 96F aerial, or - on a ladder that carries the duct rung - as gel-filled
// duct cable. The row is Corning 072ELE-T3322A20 (EMEA ecatalog spec sheet, revision date
// 2026-11-28), and this suite is the driven evidence for its notes.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

// A pole-route ladder as a caller would stock it before this row: the aerial rungs that exist,
// then the duct and drop rungs the plant still needs.
const AERIAL_NO_72 = ['g652d-adss-144', 'g652d-adss-96', 'g652d-adss-48', 'g652d-loose-48',
  'g652d-loose-24', 'g652d-loose-12', 'g657a2-drop-2', 'g657a2-drop-1'];
const AERIAL = AERIAL_NO_72.concat(['g652d-adss-72']);

test('the catalogue carries the 72F aerial rung the 48F and 96F rows skipped', function () {
  const row = registry.get('cable', 'g652d-adss-72');
  assert.strictEqual(row.fiberCount, 72);
  // 6 x 12 on the sheet; a 12-fibre tube is what every rung of the family uses.
  assert.strictEqual(row.fibersPerTube, 12);
  assert.strictEqual(row.fiberStandard, 'G.652.D');
  assert.strictEqual(row.construction, 'loose-tube');
  assert.deepStrictEqual(row.use, ['feeder', 'distribution']);
  // The sheet publishes MAXIMUM 0.36 / 0.36 / 0.22 at 1310 / 1383 / 1550 and no 1490 figure; the
  // row carries the family typical row, 1490 interpolated, exactly as g652d-adss-12/24/48 do.
  assert.deepStrictEqual(row.attenuationDbPerKm, { '1310': 0.35, '1490': 0.22, '1550': 0.21 });
  // No drumM is the family decision: 6000 m is the sheet reel ceiling, not a putup, and the BOM
  // then rounds on the engine default rather than buying a 6 km reel for a short span.
  assert.strictEqual(row.drumM, undefined, 'the 72F row publishes no drum: ' + row.drumM);
  assert.ok(row.sourceUrl.indexOf('072ELE-T3322A20') !== -1, row.sourceUrl);
});

test('a 49-72 fibre pole span takes the 72F rung instead of the 96F one', function () {
  // 1,200 m is a pole-to-pole run, far over DROP_CABLE_MAX_M (300), so cableFor takes the SMALLEST
  // rung that carries the strand count.
  for (const fibres of [49, 60, 72]) {
    assert.strictEqual(engine.design.cableForSpan(fibres, 1200, AERIAL_NO_72, registry).model,
      'g652d-adss-96', fibres + ' fibres on the old ladder bought ' +
      engine.design.cableForSpan(fibres, 1200, AERIAL_NO_72, registry).model);
    assert.strictEqual(engine.design.cableForSpan(fibres, 1200, AERIAL, registry).model,
      'g652d-adss-72', fibres + ' fibres on the new ladder bought ' +
      engine.design.cableForSpan(fibres, 1200, AERIAL, registry).model);
  }
  // The neighbours are unchanged: 48 fibres still take the 48F rung and 73 or 96 still take 96F.
  assert.strictEqual(engine.design.cableForSpan(48, 1200, AERIAL, registry).model, 'g652d-adss-48');
  assert.strictEqual(engine.design.cableForSpan(73, 1200, AERIAL, registry).model, 'g652d-adss-96');
  assert.strictEqual(engine.design.cableForSpan(96, 1200, AERIAL, registry).model, 'g652d-adss-96');
  // Short spans are not drops on this ladder: over two fibres the drop rule cannot apply, and a
  // 72-fibre span at 250 m is still a cable run.
  assert.strictEqual(engine.design.cableForSpan(72, 250, AERIAL, registry).model, 'g652d-adss-72');
});

test('the row sorts ahead of its duct twin, which is the tie-break trap the notes name', function () {
  // Equal fibre counts break on model id, so g652d-adss-72 wins a ladder naming both.
  assert.strictEqual(engine.design.cableForSpan(72, 1200, ['g652d-loose-72', 'g652d-adss-72'], registry).model,
    'g652d-adss-72');
  assert.strictEqual(engine.design.cableForSpan(72, 1200, ['g652d-loose-72'], registry).model,
    'g652d-loose-72', 'a ladder naming only the duct rung keeps the duct rung');
  // DEFAULT_LADDER names no aerial rung, so the part alone does not change a default design: a
  // 60-fibre span on the default ladder still takes the gel-filled duct cable.
  assert.strictEqual(engine.design.cableForSpan(60, 1200, engine.design.DEFAULTS.ladder, registry).model,
    'g652d-loose-96');
});

test('an aerial estate bills 40,888.8 fewer fibre-metres once the 72F rung is stocked', function () {
  // 36 houses on a 6 x 6 grid, two strands per ONT, active-over-a-tree. On the old ladder the
  // 1,334.3 m trunk carrying 72 strands is g652d-adss-96; on the new one it is g652d-adss-72, and
  // five shorter spans move with it.
  const points = [];
  for (let i = 0; i < 36; i++) {
    points.push({ label: 'H' + (i + 1), lat: 51.5 + Math.floor(i / 6) * 0.0009, lon: -0.1 + (i % 6) * 0.001 });
  }
  const opts = { headEnd: { lat: 51.49, lon: -0.1 }, technology: 'active', includeAllPlants: true };

  const before = engine.design.synthesise(points, Object.assign({ ladder: AERIAL_NO_72 }, opts), registry);
  const after = engine.design.synthesise(points, Object.assign({ ladder: AERIAL }, opts), registry);
  const treeBefore = before.candidates.filter(function (c) { return c.technology === 'active-tree' && c.feasible; })[0];
  const treeAfter = after.candidates.filter(function (c) { return c.technology === 'active-tree' && c.feasible; })[0];
  assert.ok(treeBefore && treeAfter, 'the 36-house estate routes on both ladders');

  // 24 spare fibres x 1,703.7 m of span length = 40,888.8 fibre-metres: 210,393.6 - 169,504.8.
  assert.strictEqual(treeBefore.metrics.fibreMetres, 210393.6, 'before: ' + treeBefore.metrics.fibreMetres);
  assert.strictEqual(treeAfter.metrics.fibreMetres, 169504.8, 'after: ' + treeAfter.metrics.fibreMetres);
  // Same metres, same drums: over-fibring is paid for in fibre-metres, not in cable metres.
  assert.strictEqual(treeAfter.metrics.cableM, 4463.8, 'cable metres: ' + treeAfter.metrics.cableM);
  assert.strictEqual(treeAfter.metrics.drums, 5, 'drums: ' + treeAfter.metrics.drums);

  const trunkBefore = treeBefore.plant.spans.filter(function (s) { return s.strands.length === 72; })[0];
  const trunkAfter = treeAfter.plant.spans.filter(function (s) { return s.strands.length === 72; })[0];
  assert.ok(trunkBefore && trunkAfter, 'a 72-strand trunk');
  assert.strictEqual(trunkBefore.cable, 'g652d-adss-96', 'before: ' + trunkBefore.cable);
  assert.strictEqual(trunkAfter.cable, 'g652d-adss-72', 'after: ' + trunkAfter.cable);
  assert.strictEqual(trunkAfter.lengthM, 1334.3, 'trunk length measured at 1334.3 m: ' + trunkAfter.lengthM);
});

done();
