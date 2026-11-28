'use strict';
// The ribbon family shipped 96/144/216/288/432, so a ladder built only from ribbon rows had no answer
// below 95 fibres: the smallest-that-fits rule bought 96F ribbon for a 12-, 24-, 48- or 60-fibre span.
// gh#93 fixed exactly this one rung higher (144 -> 96) and the small end was never filled in, which is
// the same defect gh#34 fixed for loose tube when it added g652d-loose-72.
//
// 24, 48 and 72 are stocked ribbon counts, not invented rungs: the ordering table the 96F row cites
// (Lightera/Prysmian AccuRibbon DC) lists 24, 48, 72, 96, 120, 144, 216, 288, 432, 864. This suite
// drives the pick, the addressing and a whole design through the engine rather than reading the prose.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const design = engine.design;
const fiber = engine.fiber;
const length = engine.length;

// Richest first, the way DEFAULT_LADDER is written - order in a ladder is a preference, never a match.
const RIBBON_BEFORE = ['g652d-ribbon-432', 'g652d-ribbon-288', 'g652d-ribbon-216', 'g652d-ribbon-144', 'g652d-ribbon-96'];
const RIBBON_NOW = RIBBON_BEFORE.concat(['g652d-ribbon-72', 'g652d-ribbon-48', 'g652d-ribbon-24']);

test('the three small ribbon rungs carry the family figures', function () {
  [['g652d-ribbon-24', 24, 2], ['g652d-ribbon-48', 48, 4], ['g652d-ribbon-72', 72, 6]].forEach(function (row) {
    const model = row[0], count = row[1], tubes = row[2];
    const part = registry.get('cable', model);
    assert.strictEqual(part.fiberCount, count, model + ' fibre count');
    assert.strictEqual(part.fibersPerTube, 12, model + ' is one 12-fibre ribbon per tube position');
    assert.strictEqual(part.construction, 'ribbon', model + ' construction');
    assert.strictEqual(part.fiberStandard, 'G.652.D', model + ' fibre standard');
    assert.strictEqual(part.drumM, 2000, model + ' keeps the 2 km floor the 96/144/216 rows use');
    assert.deepStrictEqual(part.use, ['feeder', 'distribution'], model + ' is a distribution count as well as a feeder');
    // 0.8 km x 0.22 dB/km = 0.176 dB at 1490 nm. A figure is present in every window, because a
    // window with no figure is a window the engine refuses to budget.
    assert.strictEqual(part.attenuationDbPerKm['1310'], 0.35, model + ' 1310 nm');
    assert.strictEqual(part.attenuationDbPerKm['1490'], 0.22, model + ' 1490 nm');
    assert.strictEqual(part.attenuationDbPerKm['1550'], 0.21, model + ' 1550 nm');
    assert.strictEqual(fiber.tubeCount(count, part), tubes, count + ' / 12 = ' + tubes + ' tubes');
    const check = engine.parts.validateSpec(part);
    assert.ok(check.ok, model + ' validates: ' + check.errors.join('; '));
  });
});

test('a span under 96 fibres no longer buys 96F ribbon', function () {
  // Before these rows every count from 1 to 95 answered the 96F rung - the smallest that FITS.
  [[12, 'g652d-ribbon-96'], [24, 'g652d-ribbon-96'], [48, 'g652d-ribbon-96'], [60, 'g652d-ribbon-96']].forEach(function (c) {
    assert.strictEqual(design.cableForSpan(c[0], 800, RIBBON_BEFORE, registry).model, c[1],
      c[0] + ' fibres before the rungs (the defect this PR fixes)');
  });
  // 24 holds 12 and 24; 48 holds 30 to 48; 72 holds 49 to 72; 96 still holds 73 to 96.
  assert.strictEqual(design.cableForSpan(12, 800, RIBBON_NOW, registry).model, 'g652d-ribbon-24');
  assert.strictEqual(design.cableForSpan(24, 800, RIBBON_NOW, registry).model, 'g652d-ribbon-24');
  assert.strictEqual(design.cableForSpan(48, 800, RIBBON_NOW, registry).model, 'g652d-ribbon-48');
  assert.strictEqual(design.cableForSpan(60, 800, RIBBON_NOW, registry).model, 'g652d-ribbon-72');
  assert.strictEqual(design.cableForSpan(72, 800, RIBBON_NOW, registry).model, 'g652d-ribbon-72');
  assert.strictEqual(design.cableForSpan(96, 800, RIBBON_NOW, registry).model, 'g652d-ribbon-96');
  // 120 does not fit 96 and has no rung of its own, so the 144F row is still the pick.
  assert.strictEqual(design.cableForSpan(120, 800, RIBBON_NOW, registry).model, 'g652d-ribbon-144');
  // The 60-fibre span moves from 96F to 72F on 800 m: 24 fibres x 800 m = 19,200 fibre-metres it stops
  // buying, and the 36 fibres of headroom above the demand become 12.
  assert.strictEqual((96 - 72) * 800, 19200, 'fibre-metres the 60-fibre span stops buying');
});

test('an 18-ONT estate on a ribbon ladder bills a quarter of the fibre-metres', function () {
  const demand = [];
  for (let i = 0; i < 18; i++) {
    demand.push({ label: 'H' + (i + 1), lat: 51.5 + i * 0.0004, lon: -0.1 + Math.sin(i / 5) * 0.0004 });
  }
  const headEnd = { lat: 51.499, lon: -0.1006, name: 'PoP' };

  // Straight-line x routeFactor 1.2 puts 1,549.5 m of route on the 37 spans. Every span is 96F ribbon
  // on the old ladder: 96 x 1549.5 = 148,752.0 fibre-metres.
  const before = design.synthesise(demand, { headEnd: headEnd, technology: 'pon', ladder: RIBBON_BEFORE }, registry);
  assert.strictEqual(before.best.metrics.cableM, 1549.5, 'route metres, unchanged by the cable pick');
  assert.strictEqual(before.best.metrics.fibreMetres, 148752, '96 x 1549.5 = 148,752.0');
  before.plant.spans.forEach(function (span) {
    assert.strictEqual(span.cable, 'g652d-ribbon-96', 'every span bought 96F before the rungs');
  });

  // With the three rungs named the widest span carries 12 strands, so every span is 24F:
  // 24 x 1549.5 = 37,188.0 fibre-metres, 111,564.0 fewer.
  const after = design.synthesise(demand, { headEnd: headEnd, technology: 'pon', ladder: RIBBON_NOW }, registry);
  assert.strictEqual(after.best.metrics.cableM, 1549.5, 'the same route, bought in smaller cable');
  assert.strictEqual(after.best.metrics.fibreMetres, 37188, '24 x 1549.5 = 37,188.0');
  assert.strictEqual(148752 - 37188, 111564, 'fibre-metres the estate stops buying');
  after.plant.spans.forEach(function (span) {
    assert.strictEqual(span.cable, 'g652d-ribbon-24', 'every span answers the 24F rung');
  });
});

test('a 24F span is still drummed like its neighbours', function () {
  // 1,200 m x 1.03 overlength = 1,236 m of design length; drums round once per cable model on the
  // aggregated length, so 1,236 m needs one 2,000 m drum and 2,000 - 1,236 = 764 m is spare.
  const plant = {
    name: 'Small ribbon rung',
    nodes: [
      { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'cab1', type: 'closure', model: 'ocsh-144-cabinet', name: 'Cabinet' },
      { id: 'ont1', type: 'ont', model: 'gpon-ont-4ge', name: '1 Acacia Ave' }
    ],
    spans: [
      { id: 's1', from: 'olt1', to: 'cab1', cable: 'g652d-ribbon-24', lengthM: 1200, strands: [1] },
      { id: 'd1', from: 'cab1', to: 'ont1', cable: 'g657a2-drop-1', lengthM: 40, strands: [1] }
    ]
  };
  const bom = length.billOfMaterials(plant, registry);
  const row = bom.byCable.filter(function (r) { return r.model === 'g652d-ribbon-24'; })[0];
  assert.ok(row, 'the 24F ribbon reaches the BOM');
  assert.strictEqual(row.fiberCount, 24, 'the BOM sells the fibre count of the row it picked');
  assert.strictEqual(row.designM, 1236, 'design metres: 1200 x 1.03 = 1236');
  assert.strictEqual(row.drums, 1, 'one 2000 m drum covers 1236 m');
  assert.strictEqual(row.purchaseM, 2000, 'purchase is one whole drum');
  assert.strictEqual(row.spareM, 764, '2000 - 1236 = 764 m spare');
});

test('the default ladder is untouched, so no default design moves', function () {
  // DEFAULT_LADDER names no ribbon row, so these three parts cannot reach a design that does not ask
  // for them. It also names no 72F loose-tube rung, so a 60-fibre span on the default ladder still
  // answers 96F - pinned here so the blast radius of this change is visible. Whether the default
  // should carry g652d-loose-72 is the open default-ladder question (gh#155), not this increment.
  assert.strictEqual(design.cableForSpan(60, 1200, design.DEFAULT_LADDER, registry).model, 'g652d-loose-96');
  ['g652d-ribbon-24', 'g652d-ribbon-48', 'g652d-ribbon-72'].forEach(function (model) {
    assert.strictEqual(design.DEFAULT_LADDER.indexOf(model), -1, model + ' is not a default rung');
  });
});

done();
