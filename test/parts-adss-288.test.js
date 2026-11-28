'use strict';
// The aerial family in this catalogue is the EMEA ADSS Lite line, and its own 144F sheet prints
// "single-layer stranded construction up to 144 fibers" - so the aerial rungs stopped at 144 by
// product line, while the duct ribbon family runs to 432. Corning's US SOLO ADSS line is the family
// above 144 (family spec 0009_NAFTA_AEN is headed "2-288 Fibers" and prints 288-fibre rows on five
// span codes).
//
// Without a 288 rung, a pole trunk above 144 strands has no aerial product to name and the engine
// does not refuse it: cableFor answers with the LARGEST rung in the ladder (design.js), and the
// builder then bills bundles = ceil(fibres / fiberCount), so the shortfall becomes parallel cables
// and nothing is said - the ladder warning in design.js only inspects spans that landed on a DROP
// row. Measured on main at e74ab05 with the ladder below: a 96-house active tree bills a 192-strand,
// 1,334.3 m trunk as TWO g652d-adss-144 (4 drums, 8,000 m bought), where one g652d-adss-288 is
// 2 drums and 4,000 m - same fibres bought, 1,152,000 fibre-metres either way.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const design = engine.design;
const fiber = engine.fiber;
const length = engine.length;
const MODEL = 'g652d-adss-288';

test('the 288F SOLO ADSS row is 24 tubes of 12 and names its sheet', function () {
  const part = registry.get('cable', MODEL);
  assert.strictEqual(part.fiberCount, 288);
  // 0009_NAFTA_AEN prints 24 tube positions, 24 active tubes, 12 fibres a tube.
  assert.strictEqual(part.fibersPerTube, 12);
  assert.strictEqual(fiber.tubeCount(288, part), 24, '288 / 12 = 24 tubes');
  assert.strictEqual(part.construction, 'loose-tube');
  assert.strictEqual(part.fiberStandard, 'G.652.D');
  // An aerial TRUNK is feeder plant; drop cable is a different product and cableForSpan's 300 m rule
  // reads this field.
  assert.deepStrictEqual(part.use, ['feeder'], 'feeder only, never drop');
  // The family typical row every cable here carries; the sheet publishes 0.4 / 0.4 / 0.3 MAXIMA at
  // 1310 / 1383 / 1550 nm and no 1490 figure, and the note says to hold the supplier to 0.4.
  assert.deepStrictEqual(part.attenuationDbPerKm, { '1310': 0.35, '1490': 0.22, '1550': 0.21 });
  // No drumM, the ADSS family decision: a reel ceiling is not a putup, so the BOM rounds on the
  // engine default rather than buying a long reel for a short spur.
  assert.strictEqual(part.drumM, undefined, 'publishes no drum: ' + part.drumM);
  assert.ok(part.sourceUrl.indexOf('0009_NAFTA_AEN') !== -1, part.sourceUrl);
  assert.ok(/replace/i.test(part.notes), 'notes carry the replacement caveat');
  const check = engine.parts.validateSpec(part);
  assert.ok(check.ok, MODEL + ' validates: ' + check.errors.join('; '));
  // The last strand is addressed, not inferred: 288 = T24-F12.
  assert.strictEqual(fiber.addressFor(288, part).label, 'T24-F12');
});

// A caller's pole-route ladder before and after the row: the aerial rungs that existed, the duct
// rungs a plant still needs, and the drop rungs.
const BASE = ['g652d-adss-144', 'g652d-adss-96', 'g652d-adss-48', 'g652d-loose-24', 'g652d-loose-12',
  'g657a2-drop-2', 'g657a2-drop-1'];
const WITH_288 = [MODEL].concat(BASE);

function trunk(ladder) {
  const points = [];
  for (let i = 0; i < 96; i++) {
    points.push({ label: 'H' + (i + 1), lat: 51.5 + Math.floor(i / 12) * 0.0008, lon: -0.1 + (i % 12) * 0.001 });
  }
  const out = design.synthesise(points, {
    headEnd: { lat: 51.49, lon: -0.1 }, technology: 'active', ladder: ladder, includeAllPlants: true
  }, registry);
  assert.ok(out.ok, 'the 96-house estate is feasible');
  const tree = out.candidates.filter(function (c) { return c.technology === 'active-tree' && c.feasible; })[0];
  assert.ok(tree, 'an active-tree candidate');
  const span = tree.plant.spans.filter(function (s) { return s.strands.length === 192; })[0];
  assert.ok(span, 'a 192-strand trunk: ' + JSON.stringify(tree.plant.spans.map(function (s) {
    return [s.strands.length, s.cable];
  })));
  return { span: span, bom: length.billOfMaterials(tree.plant, registry) };
}

function bomRow(bom, model) {
  return bom.byCable.filter(function (r) { return r.model === model; })[0];
}

test('without the row a 192-strand trunk is bought as two 144F cables and says nothing', function () {
  const before = trunk(BASE);
  assert.strictEqual(before.span.cable, 'g652d-adss-144', 'the largest rung, not a refusal');
  assert.strictEqual(before.span.bundles, 2, 'ceil(192 / 144) = 2 cables in parallel');
  assert.strictEqual(before.span.lengthM, 1334.3, 'trunk length measured at 1334.3 m: ' + before.span.lengthM);
  const row = bomRow(before.bom, 'g652d-adss-144');
  assert.strictEqual(row.drums, 4, '4 x 2,000 m drums: ' + JSON.stringify(row));
  assert.strictEqual(row.purchaseM, 8000, '8,000 m bought');
});

test('with the row the same trunk is one 288F cable, and the drums follow', function () {
  const after = trunk(WITH_288);
  assert.strictEqual(after.span.cable, MODEL, 'the trunk bought ' + after.span.cable);
  assert.strictEqual(after.span.bundles, 1, 'one cable carries 192 of 288 fibres');
  const row = bomRow(after.bom, MODEL);
  assert.strictEqual(row.drums, 2, '2 x 2,000 m drums: ' + JSON.stringify(row));
  assert.strictEqual(row.purchaseM, 4000, '4,000 m bought');
  // The same fibres are bought either way - 8,000 x 144 = 4,000 x 288 = 1,152,000 - so the row is a
  // product and reel difference, not a budget or ranking change.
  assert.strictEqual(8000 * 144, 4000 * 288, 'bought fibre-metres are unchanged');
});

done();
