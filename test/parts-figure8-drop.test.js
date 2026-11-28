'use strict';
// gh#147 and gh#173 gave the catalogue an aerial DISTRIBUTION family (g652d-adss-12..144), but an
// aerial DROP - the pole-to-house span, the one span every aerial route exists to reach - had no row:
// the drop family is buried flat tight-buffer cable with no messenger, and the ADSS rows deliberately
// do not carry `use: drop` because isDropCable would then pull them onto any span under 300 m.
// The rows are Prysmian ezDrop Figure 8 (data sheet TLS-DS-A-605-0226), and this suite is the driven
// evidence for their notes.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const FIG8_2 = 'g657a2-fig8-drop-2';
const FIG8_4 = 'g657a2-fig8-drop-4';

test('the catalogue carries an aerial drop with an integrated messenger, 2F and 4F', function () {
  const two = registry.get('cable', FIG8_2);
  const four = registry.get('cable', FIG8_4);
  assert.strictEqual(two.fiberCount, 2);
  assert.strictEqual(four.fiberCount, 4);
  // One 1.9 mm buffer tube holding up to 6 fibres (ordering grouping 06): the 2F and 4F builds fill
  // two and four of its positions, so both rows publish 6 rather than the installed count.
  assert.strictEqual(two.fibersPerTube, 6, 'one 6-fibre buffer tube: ' + two.fibersPerTube);
  assert.strictEqual(four.fibersPerTube, 6, 'one 6-fibre buffer tube: ' + four.fibersPerTube);
  assert.strictEqual(two.fiberStandard, 'G.657.A2');
  // B2 glass (G.657.A2/B.2/G.652.D) is an option on the sheet, not its B1 standard build; the row
  // says which one it prices.
  assert.deepStrictEqual(two.use, ['drop']);
  assert.deepStrictEqual(four.use, ['drop']);
  // E3 grade is 0.35/0.35/0.25 maximum at 1310/1383/1550 and the sheet prints no 1490 nm figure; the
  // rows carry the catalogue's typical installed row, 1490 interpolated - as every cable here does.
  assert.deepStrictEqual(two.attenuationDbPerKm, { '1310': 0.35, '1490': 0.22, '1550': 0.21 });
  assert.deepStrictEqual(four.attenuationDbPerKm, { '1310': 0.35, '1490': 0.22, '1550': 0.21 });
  // R-18 ply, 2,100 ft / 640 m: the contractor spool a drop order arrives on, not the R-30 ply reel.
  assert.strictEqual(two.drumM, 640);
  assert.strictEqual(four.drumM, 640);
  assert.ok(two.sourceUrl.indexOf('ezDrop') !== -1, two.sourceUrl);
  assert.ok(four.sourceUrl.indexOf('ezDrop') !== -1, four.sourceUrl);
});

test('a ladder naming the aerial drop AND the buried drop buys the buried one - name only one', function () {
  // cableFor answers with the smallest cable that fits and breaks ties on model id; 'g657a2-drop-2'
  // sorts before 'g657a2-fig8-drop-2', so the messenger silently disappears from a ladder with both.
  assert.strictEqual(engine.design.cableForSpan(2, 60, [FIG8_2, 'g657a2-drop-2'], registry).model,
    'g657a2-drop-2', 'the tie-break goes to the buried rung, which is the trap the notes name');
  assert.strictEqual(engine.design.cableForSpan(2, 60, [FIG8_2], registry).model, FIG8_2,
    'a ladder naming only the aerial rung gets the aerial rung');
  // DEFAULT_LADDER names no aerial drop, so the part alone does not change an existing design.
  assert.strictEqual(engine.design.cableForSpan(2, 60, engine.design.DEFAULTS.ladder, registry).model,
    'g657a2-drop-2');
});

test('a four-fibre aerial span takes the 4F figure-8 instead of a 12-fibre run', function () {
  // cableForDistribution takes a drop rung at any size for a span up to DROP_CABLE_MAX_M (300 m).
  assert.strictEqual(engine.design.cableForSpan(4, 70, [FIG8_4], registry).model, FIG8_4);
  // Before this rung the only four-fibre answer on a drop-and-distribution ladder was the 12F run:
  // eight spare fibres hanging from a pole.
  assert.strictEqual(engine.design.cableForSpan(4, 70, ['g652d-loose-12', 'g657a2-drop-2'], registry).model,
    'g652d-loose-12');
});

test('the engine lets a 250 m pole span onto a 125 m messenger - the span limit is in the sheet', function () {
  // DROP_CABLE_MAX_M is 300 m, so the engine's own refusal is looser than the cable's rating: the
  // messenger self-supports 125 m (NESC Light, 1% sag), and nothing computes sag, tension, ice or wind.
  assert.strictEqual(engine.design.cableForSpan(2, 250, ['g652d-loose-12', FIG8_2], registry).model, FIG8_2,
    'a 250 m span passes the 300 m drop refusal');
  assert.strictEqual(engine.design.cableForSpan(2, 350, ['g652d-loose-12', FIG8_2], registry).model,
    'g652d-loose-12', 'past 300 m the drop rung is refused and a 12F run is bought');
});

test('a 640 m spool bills 640 m for an eight-house aerial estate, not the 2,000 m default', function () {
  const spans = [];
  for (let i = 0; i < 8; i++) spans.push({ id: 's' + i, cable: FIG8_2, lengthM: 60, splices: 0, closures: 0 });
  const bom = engine.length.billOfMaterials({ spans: spans }, registry, { overlengthPct: 3 });
  const row = bom.byCable[0];
  // 8 x 60 m = 480 m route, +3% overlength = 494.4 m of design length, one 640 m spool, 145.6 m spare.
  assert.strictEqual(row.model, FIG8_2);
  assert.strictEqual(row.designM, 494.4, 'designM: ' + row.designM);
  assert.strictEqual(row.drums, 1);
  assert.strictEqual(row.purchaseM, 640, 'one R-18 ply spool: ' + row.purchaseM);
  assert.strictEqual(row.spareM, 145.6, 'spare: ' + row.spareM);
  // With no declared drum the engine falls back to 2,000 m and buys a 2 km reel for 494 m of route.
  const fallback = engine.length.cableToBuy({ routeM: 494.4, overlengthPct: 3 });
  assert.strictEqual(fallback.purchaseM, 2000, 'the default drum: ' + fallback.purchaseM);
});

done();
