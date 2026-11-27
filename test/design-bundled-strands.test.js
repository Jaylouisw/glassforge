'use strict';
// A span that runs more than one cable holds more than one cable's fibres.
//
// `spans[].bundles` is how many whole cables run one route (SPEC §5), and the strand capacity of a
// span is every cable's fibres (SPEC §6: "18 strands in use on a 2 x 12 span is three-quarters
// full"). Auto-design, however, listed only `1..fibersPerCable` on a bundled span: a 37-ONT active
// tree span drew seven 12-fibre cables (84 fibres of capacity, 74 live) and claimed **12 strands in
// use, 72 spare, 14.3%** - and the splice sheet scheduled 24 rows (12 strands at each end) for 74
// live fibres, so 62 fibres that must be spliced were simply absent from the sheet a crew carries.
// gh#96. The address of a strand inside a bundle (which cable a sheet row belongs to) is a separate
// gap, gh#95 - this test is about the count, which the capacity model already allowed.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const HEAD_END = { lat: 51.499, lon: -0.1006 };

// Deterministic demand: no RNG in the design path, so this estate is the same on every run.
function street(n, stepDeg) {
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({ label: 'H' + i, lat: 51.5 + i * stepDeg, lon: -0.1 + Math.sin(i / 5) * 0.0009 });
  }
  return points;
}

// A 40-house active tree on a 12-fibre ladder: each terminal needs two fibres (tx/rx), so the spans
// near the head end carry 74 fibres over seven cables. The ladder is the caller's own, which is what
// makes this reachable without an unrealistic estate.
function bundledDesign() {
  const out = engine.design.synthesise(street(40, 0.0004), {
    headEnd: HEAD_END,
    technology: 'active',
    ladder: ['g652d-loose-12']
  }, registry);
  assert.strictEqual(out.best.technology, 'active-tree', 'the active tree must be the ranked design');
  assert.strictEqual(out.best.feasible, true, 'the design must be buildable: ' + out.best.warnings.join('; '));
  // `plant` is the ranked plant, and the spans below are read from it rather than from a candidate.
  return out.plant;
}

test('a bundled span lists every fibre in use, not one cable\'s worth', function () {
  const plant = bundledDesign();
  const bundled = plant.spans.filter(function (s) { return s.bundles > 1; });
  assert.ok(bundled.length > 0, 'the estate must produce a bundled span, or this test proves nothing');

  bundled.forEach(function (span) {
    const capacity = registry.get('cable', span.cable).fiberCount * span.bundles;
    // Two fibres per terminal on an active tree; a drop span still lists its own [1, 2].
    const fibresNeeded = span.feedsOnts * 2;
    assert.ok(fibresNeeded > registry.get('cable', span.cable).fiberCount,
      'span ' + span.id + ' must need more fibres than one cable holds, or it is not the case tested');
    assert.strictEqual(span.strands.length, Math.min(fibresNeeded, capacity),
      'span ' + span.id + ' carries ' + span.bundles + ' x ' + span.cable + ' (' + capacity +
      ' fibres) and uses ' + fibresNeeded + ' - it cannot list ' + span.strands.length + ' strands');
    // The list is the run 1..n: no gaps, no repeats.
    for (let i = 0; i < span.strands.length; i++) assert.strictEqual(span.strands[i], i + 1);
  });
});

test('the strand ledger counts the bundled span at its real utilisation', function () {
  const plant = bundledDesign();
  const span = plant.spans.filter(function (s) { return s.bundles > 1; })
    .sort(function (a, b) { return b.bundles - a.bundles; })[0];
  const capacity = registry.get('cable', span.cable).fiberCount * span.bundles;
  const fibresNeeded = span.feedsOnts * 2;                         // 37 ONTs x 2 = 74 fibres
  const expectedUsed = Math.min(fibresNeeded, capacity);           // over 7 x 12 = 84 -> 74
  const row = engine.network.strandLedger(plant, registry).rows
    .filter(function (r) { return r.span === span.id; })[0];

  assert.strictEqual(row.used, expectedUsed, 'used must be the live fibres, not one cable\'s worth');
  assert.strictEqual(row.spare, capacity - expectedUsed);          // 84 - 74 = 10
  assert.strictEqual(row.utilisation, Math.round((expectedUsed / capacity) * 1000) / 10);
  assert.strictEqual(row.overbooked, false);
  assert.strictEqual(row.error, undefined);
  // The plant is still valid: the fix adds strands the capacity already allowed.
  assert.deepStrictEqual(engine.network.validate(plant, registry).errors, []);
});

done();
