'use strict';
// The aerial family shipped 12/24/48 (gh#147), 72 for the 49-72 band and 96/144 (gh#173), so the
// ladder skips the 12-multiples in between: cableFor answers with the SMALLEST cable that fits, and a
// 25-36 fibre pole span was bought as 48F while a 49-60 fibre span was bought as 72F. Both rungs are
// real Corning builds on the same 12-position stranded core as the rows already catalogued -
// 036ELE-T3322A20 (3 x 12) and 060ELE-T3322A20 (5 x 12) - and this suite is the driven evidence for
// their notes rather than a second reading of the prose.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const design = engine.design;
const fiber = engine.fiber;

// A pole-route ladder as a caller would stock it before these rows: the aerial rungs that exist,
// then the duct and drop rungs a plant still needs.
const AERIAL_BEFORE = ['g652d-adss-144', 'g652d-adss-96', 'g652d-adss-72', 'g652d-adss-48',
  'g652d-loose-48', 'g652d-loose-24', 'g652d-loose-12', 'g657a2-drop-2', 'g657a2-drop-1'];
const AERIAL = AERIAL_BEFORE.concat(['g652d-adss-60', 'g652d-adss-36']);

test('the catalogue carries the 36F and 60F aerial rungs the ladder skipped', function () {
  [['g652d-adss-36', 36, 3], ['g652d-adss-60', 60, 5]].forEach(function (row) {
    const model = row[0], count = row[1], tubes = row[2];
    const part = registry.get('cable', model);
    assert.strictEqual(part.fiberCount, count, model + ' fibre count');
    // 3 x 12 and 5 x 12 on the sheet; a 12-fibre tube is what every rung of the family uses.
    assert.strictEqual(part.fibersPerTube, 12, model + ' is 12 fibres a tube');
    assert.strictEqual(part.construction, 'loose-tube', model + ' construction');
    assert.strictEqual(part.fiberStandard, 'G.652.D', model + ' fibre standard');
    assert.deepStrictEqual(part.use, ['feeder', 'distribution'], model + ' is feeder and distribution, never drop');
    // The sheets publish MAXIMA 0.36 / 0.36 / 0.22 at 1310 / 1383 / 1550 nm and no 1490 figure; the
    // rows carry the family typical row with 1490 interpolated, exactly as g652d-adss-12/24/48 do.
    assert.deepStrictEqual(part.attenuationDbPerKm, { '1310': 0.35, '1490': 0.22, '1550': 0.21 },
      model + ' attenuation row');
    // No drumM is the family decision: 6000 m is the sheet reel ceiling, not a putup, so the BOM
    // rounds on the engine default rather than buying a 6 km reel for a short aerial spur.
    assert.strictEqual(part.drumM, undefined, model + ' publishes no drum: ' + part.drumM);
    assert.strictEqual(fiber.tubeCount(count, part), tubes, count + ' / 12 = ' + tubes + ' tubes');
    const check = engine.parts.validateSpec(part);
    assert.ok(check.ok, model + ' validates: ' + check.errors.join('; '));
  });
  assert.ok(registry.get('cable', 'g652d-adss-36').sourceUrl.indexOf('036ELE-T3322A20') !== -1,
    registry.get('cable', 'g652d-adss-36').sourceUrl);
  assert.ok(registry.get('cable', 'g652d-adss-60').sourceUrl.indexOf('060ELE-T3322A20') !== -1,
    registry.get('cable', 'g652d-adss-60').sourceUrl);
  // The last strand is addressed, not inferred: 36 = T03-F12, 60 = T05-F12.
  assert.strictEqual(fiber.addressFor(36, registry.get('cable', 'g652d-adss-36')).label, 'T03-F12');
  assert.strictEqual(fiber.addressFor(60, registry.get('cable', 'g652d-adss-60')).label, 'T05-F12');
});

test('a 25-36 fibre pole span takes the 36F rung, a 49-60 fibre span the 60F one', function () {
  // 1,200 m is a pole-to-pole run, far over DROP_CABLE_MAX_M (300), so the distribution rule applies
  // and cableFor takes the smallest rung that carries the strand count.
  [[25, 48], [32, 48], [36, 48], [49, 72], [56, 72], [60, 72]].forEach(function (c) {
    const got = design.cableForSpan(c[0], 1200, AERIAL_BEFORE, registry).model;
    assert.strictEqual(got, 'g652d-adss-' + c[1], c[0] + ' fibres on the old ladder bought ' + got);
  });
  [25, 32, 36].forEach(function (n) {
    assert.strictEqual(design.cableForSpan(n, 1200, AERIAL, registry).model, 'g652d-adss-36', n + ' fibres');
  });
  [49, 56, 60].forEach(function (n) {
    assert.strictEqual(design.cableForSpan(n, 1200, AERIAL, registry).model, 'g652d-adss-60', n + ' fibres');
  });
  // The neighbours do not move: 37-48 still answers the 48F rung and 61-72 still the 72F one.
  assert.strictEqual(design.cableForSpan(37, 1200, AERIAL, registry).model, 'g652d-adss-48');
  assert.strictEqual(design.cableForSpan(48, 1200, AERIAL, registry).model, 'g652d-adss-48');
  assert.strictEqual(design.cableForSpan(61, 1200, AERIAL, registry).model, 'g652d-adss-72');
  assert.strictEqual(design.cableForSpan(72, 1200, AERIAL, registry).model, 'g652d-adss-72');
});

function treeEstate(houses, ladder) {
  const points = [];
  for (let i = 0; i < houses; i++) {
    points.push({ label: 'H' + (i + 1), lat: 51.5 + Math.floor(i / 6) * 0.0009, lon: -0.1 + (i % 6) * 0.001 });
  }
  const result = design.synthesise(points,
    { headEnd: { lat: 51.49, lon: -0.1 }, technology: 'active', includeAllPlants: true, ladder: ladder }, registry);
  const tree = result.candidates.filter(function (c) { return c.technology === 'active-tree' && c.feasible; })[0];
  assert.ok(tree, 'the estate routes on this ladder');
  return tree;
}

test('a 16-house aerial tree bills 16,011.6 fewer fibre-metres once the 36F rung is stocked', function () {
  // Two strands per ONT, so the 1,334.3 m trunk carries 32 strands: 48 x 1,334.3 = 64,046.4
  // fibre-metres before and 36 x 1,334.3 = 48,034.8 after. The estate total moves 81,864.2 ->
  // 65,852.6, which is 12 x 1,334.3 = 16,011.6, and no other span changes.
  const before = treeEstate(16, AERIAL_BEFORE);
  const after = treeEstate(16, AERIAL);
  assert.strictEqual(before.metrics.fibreMetres, 81864.2, 'before: ' + before.metrics.fibreMetres);
  assert.strictEqual(after.metrics.fibreMetres, 65852.6, 'after: ' + after.metrics.fibreMetres);
  const trunkBefore = before.plant.spans.filter(function (s) { return s.strands.length === 32; })[0];
  const trunkAfter = after.plant.spans.filter(function (s) { return s.strands.length === 32; })[0];
  assert.strictEqual(trunkBefore.cable, 'g652d-adss-48', 'before: ' + trunkBefore.cable);
  assert.strictEqual(trunkAfter.cable, 'g652d-adss-36', 'after: ' + trunkAfter.cable);
  assert.strictEqual(trunkAfter.lengthM, 1334.3, 'trunk measured at 1,334.3 m: ' + trunkAfter.lengthM);
  // Same route, same drums: over-fibring is paid for in fibre-metres, not in cable metres.
  assert.strictEqual(after.metrics.cableM, 2670.8, 'cable metres: ' + after.metrics.cableM);
  assert.strictEqual(after.metrics.drums, 4, 'drums: ' + after.metrics.drums);
});

test('the 60F rung drops 18,450 fibre-metres from a 28-house estate and costs one whole drum', function () {
  // Three spans move: the 26F and 32F short runs come off the 48F rung (36F carries both) and the
  // 1,334.3 m trunk comes off the 72F one. 12 x (83.1 + 120.1 + 1,334.3) = 18,450.0 fibre-metres.
  // Drums go 5 -> 6 because drums round once per cable model and the same metres now sit on three
  // models instead of two: the trade the note records, not a rounding defect.
  const before = treeEstate(28, AERIAL_BEFORE);
  const after = treeEstate(28, AERIAL);
  assert.strictEqual(before.metrics.fibreMetres, 144720.2, 'before: ' + before.metrics.fibreMetres);
  assert.strictEqual(after.metrics.fibreMetres, 126270.2, 'after: ' + after.metrics.fibreMetres);
  // Subtracted in the suite, so it is rounded to a tenth: 144720.2 - 126270.2 differs by 1.5e-11.
  assert.strictEqual(Number((before.metrics.fibreMetres - after.metrics.fibreMetres).toFixed(1)), 18450,
    '12 x (83.1 + 120.1 + 1334.3) = 18,450.0');
  assert.strictEqual(before.metrics.drums, 5, 'before: ' + before.metrics.drums);
  assert.strictEqual(after.metrics.drums, 6, 'after: ' + after.metrics.drums);
  assert.strictEqual(after.metrics.cableM, before.metrics.cableM, 'the route does not move');
});

test('the default ladder is untouched, so no default design moves', function () {
  // DEFAULT_LADDER names no aerial row at all, so a 32-fibre span on it still buys duct cable and
  // these parts cannot reach a design that does not ask for them.
  assert.strictEqual(design.cableForSpan(32, 1200, design.DEFAULTS.ladder, registry).model, 'g652d-loose-48');
  ['g652d-adss-36', 'g652d-adss-60'].forEach(function (model) {
    assert.strictEqual(design.DEFAULT_LADDER.indexOf(model), -1, model + ' is not a default rung');
  });
});

done();
