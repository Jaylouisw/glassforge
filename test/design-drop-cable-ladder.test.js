'use strict';
// A span's cable comes from the caller's ladder - including the drop.
//
// The defect this exists for: `cableForSpan` sends a span of two fibres or fewer, at or below
// `DROP_CABLE_MAX_M`, to `cableForDistribution`, which named `g657a2-drop-1` / `g657a2-drop-2`
// straight out of the catalogue. That is the same bug the head of `cableForSpan` was fixed for: a
// caller who stocks one cable (`ladder: ['g652d-loose-12']`) was billed for 1- and 2-fibre drop on
// every short run - a product they excluded - and a `costs` model that priced exactly the ladder they
// named was refused for a cable the design was never entitled to build with:
//
//   costs.cablePerM has no price for g657a2-drop-1, g657a2-drop-2 - a money objective that treats an
//   unpriced cable as free ranks the wrong design
//
// docs/API.md is plain about the contract: "the ladder is the cable list every span is chosen from".
// Drop cable is a rung of the ladder, not an exception to it - the default ladder lists both drop
// rungs, so an ordinary design still buys them.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const HEAD_END = { lat: 51.499, lon: -0.1004, name: 'PoP' };

// Ten houses 0.0004 deg apart (~44.5 m of latitude each), so the demand is a short ordinary estate.
function estate() {
  const points = [];
  for (let i = 0; i < 10; i++) points.push({ label: 'House ' + (i + 1), lat: 51.5 + i * 0.0004, lon: -0.1 });
  return points;
}

test('a short span takes drop cable only when the ladder has a drop rung', function () {
  const one = engine.design.cableForSpan(1, 50, engine.design.DEFAULT_LADDER, registry);
  assert.strictEqual(one.model, 'g657a2-drop-1', 'a 50 m single-fibre span on the default ladder');
  const two = engine.design.cableForSpan(2, 120, engine.design.DEFAULT_LADDER, registry);
  assert.strictEqual(two.model, 'g657a2-drop-2', 'a 120 m two-fibre span on the default ladder');

  // The same spans when the caller stocks no drop cable. 50 m and 120 m are still drops by length,
  // but there is no drop rung to buy them from, so they come from the ladder.
  assert.strictEqual(engine.design.cableForSpan(1, 50, ['g652d-loose-12'], registry).model,
    'g652d-loose-12', 'a 50 m span was bought outside a one-cable ladder');
  assert.strictEqual(engine.design.cableForSpan(2, 120, ['g652d-loose-12', 'g652d-loose-24'], registry).model,
    'g652d-loose-12', 'a 120 m span was bought outside a two-cable ladder');
});

test('a design whose ladder excludes drop cable builds no drop cable', function () {
  // Before the fix this plant carried g657a2-drop-2 on its distribution spans: two fibres or fewer
  // over <= 300 m was drop cable by construction, whatever the ladder said.
  const ladder = ['g652d-loose-12', 'g652d-loose-24'];
  const out = engine.design.synthesise(estate(), { headEnd: HEAD_END, technology: 'pon', ladder: ladder }, registry);
  assert.ok(out.ok, 'the estate is feasible: ' + JSON.stringify(out.candidates.map(function (c) { return [c.label, c.feasible, c.reasons.slice(0, 2)]; })));
  for (const span of out.plant.spans) {
    assert.ok(ladder.indexOf(span.cable) !== -1,
      span.id + ' (' + span.purpose + ', ' + span.lengthM + ' m) was bought on ' + span.cable + ', which the ladder excludes');
  }
});

test('a price list that covers the ladder is enough to rank in money', function () {
  // Ten houses, one cable stocked and priced. Before the fix the design built drop cable nobody had
  // priced (or named), and the refusal told the caller to price a cable their ladder excludes.
  const out = engine.design.synthesise(estate(), {
    headEnd: HEAD_END,
    technology: 'pon',
    ladder: ['g652d-loose-12'],
    costs: { splice: 8, closure: 120, splitter: 40, cablePerM: { 'g652d-loose-12': 1.1 } }
  }, registry);
  assert.strictEqual(out.objective, 'cost');
  assert.ok(out.ok, 'a priced one-cable ladder designs: ' + JSON.stringify(out.candidates.map(function (c) { return [c.label, c.feasible, c.reasons.slice(0, 2)]; })));
  assert.ok(out.best.metrics.cost > 0, 'the ranked cost is a figure, got ' + out.best.metrics.cost);
});

done();
