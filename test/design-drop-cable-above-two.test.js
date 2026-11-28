'use strict';
// A short span's cable: the smallest rung of the caller's ladder that carries its fibres, and "drop"
// is the catalogue's word for the product rather than a fibre count.
//
// The rule read `fibres <= 2` in two places, which was only true while the drop family stopped at
// `g657a2-drop-2`. It does not stop there: a four-fibre flat drop is a real catalogue rung (it feeds
// a four-port tap where the alternative is two two-fibre drops down one span), and an active tree
// really does produce short three- and four-fibre spans - measured on this engine, twenty houses in
// a line gave tree spans of 1 to 4 fibres over 26.7 m. The rung arrives as a catalogue PR (#140);
// the engine change it needs, and this test, is gh#144.
//
// Measured before the fix, with a four-fibre drop in the ladder:
//   cableForSpan(4, 100, ['fixture-drop-2', 'fixture-drop-4', 'fixture-loose-12']) -> fixture-loose-12
// twelve fibres of gel-filled outdoor loose tube on a 2000 m drum, to light four fibres over 100 m -
// a product the caller's own ladder says they do not pull on a drop.
//
// The rule now asks the catalogue what a drop is (its `use`), which is the same metadata
// `isDropCable` reads and the reason it is not a model check. The two-fibre size rule survives for a
// ladder that names no drop rung at all, and the length rule is untouched: over `DROP_CABLE_MAX_M`
// a span is a cable run and drop cable stays out of the BOM whatever its fibre count.
//
// The four-fibre and two-fibre-patch cables are fixtures dropped into a throwaway copy of the
// catalogue, not additions to it: this test is about the rule, and the catalogue's own drop family
// already has its case in test/design-drop-cable-ladder.test.js. A four-fibre rung is a catalogue
// change with its own provenance and notes, and its own PR.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, done } = require('./harness');
const engine = require('../engine');

function cableSpec(model, fiberCount, use) {
  return {
    kind: 'cable',
    model: model,
    label: 'fixture ' + model,
    fiberCount: fiberCount,
    fibersPerTube: Math.min(fiberCount, 12),
    construction: 'tight-buffer',
    use: use,
    // 0.35 / 0.22 / 0.21 dB/km: the typical installed row every drop in this catalogue carries, so
    // a fixture span budgets the same way a catalogued one does.
    attenuationDbPerKm: { '1310': 0.35, '1490': 0.22, '1550': 0.21 },
    sourceUrl: 'https://example.invalid/fixture-cable',
    notes: 'test fixture, not a catalogue part'
  };
}

// A copy of the real catalogue plus the fixture cables: the unit cases need only cables, but the
// design case at the end needs the real ONTs, transceivers and OLTs to build a plant at all.
function fixtureRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-drop4-'));
  fs.cpSync(engine.parts.DEFAULT_PARTS_DIR, path.join(dir, 'parts'), { recursive: true });
  const cableDir = path.join(dir, 'parts', 'cable');
  const cables = [
    cableSpec('fixture-drop-2', 2, ['drop']),
    cableSpec('fixture-drop-4', 4, ['drop']),
    cableSpec('fixture-indoor-4', 4, ['indoor']),
    cableSpec('fixture-patch-2', 2, ['indoor']),
    cableSpec('fixture-loose-12', 12, ['feeder', 'distribution'])
  ];
  for (const spec of cables) {
    fs.writeFileSync(path.join(cableDir, spec.model + '.json'), JSON.stringify(spec));
  }
  return { dir: dir, registry: engine.createRegistry(path.join(dir, 'parts')) };
}

const fixture = fixtureRegistry();
const registry = fixture.registry;
const LADDER = ['fixture-drop-2', 'fixture-drop-4', 'fixture-loose-12'];

test('the fixture registry loaded without a problem', function () {
  // A fixture that does not validate would make every case below pass for the wrong reason.
  assert.deepStrictEqual(registry.problems, [], 'fixture parts problems: ' + JSON.stringify(registry.problems));
  assert.strictEqual(registry.get('cable', 'fixture-drop-4').fiberCount, 4);
});

test('a short span of three or four fibres buys the four-fibre drop on the ladder', function () {
  // The defect: both answered fixture-loose-12 (12F gel-filled loose tube, 2000 m drum) before the
  // fix, because the drop branch stopped at two fibres.
  const three = engine.design.cableForSpan(3, 100, LADDER, registry);
  assert.strictEqual(three.model, 'fixture-drop-4', 'a 100 m three-fibre span bought ' + three.model);
  const four = engine.design.cableForSpan(4, 100, LADDER, registry);
  assert.strictEqual(four.model, 'fixture-drop-4', 'a 100 m four-fibre span bought ' + four.model);

  // The smallest rung that fits still wins: four fibres do not buy the 12F rung, and two fibres do
  // not buy the four-fibre drop.
  assert.strictEqual(engine.design.cableForSpan(2, 100, LADDER, registry).model, 'fixture-drop-2',
    'a 100 m two-fibre span should stay on the two-fibre drop');
});

test('a drop rung is a drop because the catalogue says so, not because of its size', function () {
  // A four-fibre indoor cable is not a drop, so a four-fibre short span keeps the ladder's floor.
  const indoor = engine.design.cableForSpan(4, 100, ['fixture-indoor-4', 'fixture-loose-12'], registry);
  assert.strictEqual(indoor.model, 'fixture-loose-12',
    'a 100 m four-fibre span bought ' + indoor.model + ', which the catalogue does not call a drop');

  // The two-fibre size rule is unchanged for a ladder that names no drop rung: a two-fibre indoor
  // cable is still taken by a two-fibre short span, as it was before this change.
  const patch = engine.design.cableForSpan(2, 100, ['fixture-patch-2', 'fixture-loose-12'], registry);
  assert.strictEqual(patch.model, 'fixture-patch-2', 'a two-fibre short span bought ' + patch.model);

  // And a drop that cannot carry the fibres is not this span's cable.
  assert.strictEqual(engine.design.cableForSpan(6, 100, LADDER, registry).model, 'fixture-loose-12',
    'a drop of four fibres cannot be bought for a six-fibre span');
});

test('the length rule still outranks the drop family', function () {
  // Over DROP_CABLE_MAX_M (300 m) a span is a cable run: drop cable stays out of the BOM whatever
  // the fibre count, which is the rule the drop allowance must not erode.
  const long = engine.design.cableForSpan(4, 1200, LADDER, registry);
  assert.strictEqual(long.model, 'fixture-loose-12', 'a 1.2 km four-fibre span bought ' + long.model);
  const justOver = engine.design.cableForSpan(4, 301, LADDER, registry);
  assert.strictEqual(justOver.model, 'fixture-loose-12', 'a 301 m four-fibre span bought ' + justOver.model);
  const atLimit = engine.design.cableForSpan(4, 300, LADDER, registry);
  assert.strictEqual(atLimit.model, 'fixture-drop-4', 'a 300 m four-fibre span bought ' + atLimit.model);
});

test('a real design puts the four-fibre drop on its short four-fibre spans', function () {
  // The unit rule through the thing that spends money: an active tree of five houses tens of metres
  // apart. Each ONT costs two strands, so the four-house branch is a four-strand span over tens of
  // metres - exactly what the four-fibre rung is for.
  const points = [];
  for (let i = 0; i < 5; i++) points.push({ label: 'House ' + (i + 1), lat: 51.5 + i * 0.0002, lon: -0.1 });
  const out = engine.design.synthesise(points, {
    headEnd: { lat: 51.49, lon: -0.1 }, technology: 'active', ladder: LADDER, includeAllPlants: true
  }, registry);
  assert.ok(out.ok, 'the five-house estate is feasible: ' + JSON.stringify(out.candidates.map(function (c) {
    return [c.technology, c.feasible, c.reasons.slice(0, 2)];
  })));
  const tree = out.candidates.filter(function (c) { return c.technology === 'active-tree' && c.feasible; })[0];
  assert.ok(tree, 'an active-tree candidate');
  const shortFour = tree.plant.spans.filter(function (s) {
    return s.lengthM <= engine.design.DROP_CABLE_MAX_M && s.strands.length === 4;
  });
  assert.ok(shortFour.length > 0, 'a short four-strand span to check: ' +
    JSON.stringify(tree.plant.spans.map(function (s) { return [s.id, s.lengthM, s.strands.length, s.cable]; })));
  for (const span of shortFour) {
    assert.strictEqual(span.cable, 'fixture-drop-4',
      span.id + ' (' + span.lengthM + ' m, ' + span.strands.length + ' strands) was billed ' + span.cable);
  }
  // Nothing outside the ladder, and no drop over the length limit.
  for (const span of tree.plant.spans) {
    assert.ok(LADDER.indexOf(span.cable) !== -1, span.id + ' was billed ' + span.cable + ', outside the ladder');
    if (span.lengthM > engine.design.DROP_CABLE_MAX_M) {
      assert.ok(registry.get('cable', span.cable).fiberCount >= 12,
        span.id + ' is ' + span.lengthM + ' m on ' + span.cable);
    }
  }
});

test('the fixture directory is removed from the temp tree', function () {
  fs.rmSync(fixture.dir, { recursive: true, force: true });
  assert.strictEqual(fs.existsSync(fixture.dir), false, 'the fixture parts directory was left behind');
});

done();
