'use strict';
// gh#144 on the real catalogue: the rule the engine now follows (a short span takes a drop rung of the
// caller's ladder at any fibre count) has to meet the part the catalogue actually ships
// (parts/cable/g657a2-drop-4.json), not only the test fixtures in
// test/design-drop-cable-above-two.test.js. This suite is the driven evidence for that part's notes.
//
// The fixture suite proves the rule; this one proves the shipped rung is the one a caller-supplied
// ladder reaches, and that the length rule still keeps it off a run over 300 m. DEFAULT_LADDER does
// not name the rung yet - whether it should is gh#155, a decision that re-ranks default candidates,
// so it is deliberately not asserted here either way.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
// A caller's ladder that stocks the four-fibre drop beside loose tube, richest first.
const LADDER = ['g652d-loose-12', 'g657a2-drop-4', 'g657a2-drop-2', 'g657a2-drop-1'];

test('the catalogue rung is a four-fibre drop', function () {
  // If the part were not loaded or not labelled a drop, every case below would answer loose-12 and
  // the suite would be testing nothing. The table is the catalogue's `use`, not a model check.
  const cable = registry.get('cable', 'g657a2-drop-4');
  assert.strictEqual(cable.fiberCount, 4);
  assert.deepStrictEqual(cable.use, ['drop']);
});

test('a short three- or four-fibre span takes the real four-fibre drop', function () {
  // Before gh#144/#146 both answered g652d-loose-12: twelve fibres of gel-filled outdoor loose tube
  // on a 2000 m drum, to light four fibres over 100 m.
  assert.strictEqual(engine.design.cableForSpan(3, 100, LADDER, registry).model, 'g657a2-drop-4',
    'a 100 m three-fibre span bought ' + engine.design.cableForSpan(3, 100, LADDER, registry).model);
  assert.strictEqual(engine.design.cableForSpan(4, 100, LADDER, registry).model, 'g657a2-drop-4',
    'a 100 m four-fibre span bought ' + engine.design.cableForSpan(4, 100, LADDER, registry).model);
  // The smallest rung that fits still wins: two fibres stay on the two-fibre drop, and the limit is
  // inclusive (300 m is a span, 301 m is a run).
  assert.strictEqual(engine.design.cableForSpan(2, 100, LADDER, registry).model, 'g657a2-drop-2');
  assert.strictEqual(engine.design.cableForSpan(4, 300, LADDER, registry).model, 'g657a2-drop-4');
  assert.strictEqual(engine.design.cableForSpan(4, 301, LADDER, registry).model, 'g652d-loose-12',
    'over DROP_CABLE_MAX_M a span is a cable run, so the 12-fibre floor applies');
});

test('a design on the real catalogue bills its short four-strand span the four-fibre drop', function () {
  // Five houses 26.7 m apart: each ONT costs two strands, so the middle branch is a four-strand span
  // over 26.7 m - the shape the rung exists for. Spans of six and eight strands still go to the
  // 12-fibre cable, which is the ladder's floor above what the drop family carries.
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
  const byStrands = {};
  for (const span of tree.plant.spans) {
    if (span.lengthM <= engine.design.DROP_CABLE_MAX_M) byStrands[span.strands.length] = span.cable;
  }
  assert.strictEqual(byStrands[4], 'g657a2-drop-4',
    'the four-strand short span bought ' + byStrands[4] + ': ' +
    JSON.stringify(tree.plant.spans.map(function (s) { return [s.id, s.lengthM, s.strands.length, s.cable]; })));
  assert.strictEqual(byStrands[2], 'g657a2-drop-2', 'a two-strand short span bought ' + byStrands[2]);
  assert.strictEqual(byStrands[6], 'g652d-loose-12',
    'a six-strand span does not fit the four-fibre drop and takes the ladder floor: ' + byStrands[6]);
});

done();
