'use strict';
// The money objective: what a design costs is what you hand over for the drums, and the ranked number
// must be reviewable - a cable term, a splice term, a closure term, a splitter term, and their sum.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const HEAD_END = { lat: 51.499, lon: -0.1006, name: 'PoP' };
const COSTS = {
  splice: 8,
  closure: 120,
  splitter: 40,
  cablePerM: {
    'g652d-loose-12': 1.1, 'g652d-loose-24': 2.0, 'g652d-loose-48': 3.2, 'g652d-loose-96': 6.0,
    'g657a2-drop-1': 0.4, 'g657a2-drop-2': 0.6
  }
};

function street(n, stepDeg) {
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({
      label: 'House ' + (i + 1),
      lat: 51.5 + i * stepDeg,
      lon: -0.1 + Math.sin(i / 5) * 0.0004
    });
  }
  return points;
}

function winner(n) {
  const out = engine.design.synthesise(street(n, 0.0008), { headEnd: HEAD_END, costs: COSTS }, registry);
  const candidate = out.candidates.filter(function (c) { return c.feasible; })[0];
  assert.ok(candidate, 'a feasible candidate to price');
  return { out: out, candidate: candidate };
}

test('the money objective prices the drums the design buys, not the design metres', function () {
  const w = winner(30);
  const bom = w.candidate.bom;

  // Cable is bought on the cable's own drum, rounded once per model - so the cable nobody sells in
  // 0.57 m steps costs a whole drum. Pricing `designM` quoted 3 drums of cable as ~1.4 km of it and
  // the money ranking then disagreed with the BOM it had just built: the 2 km drum you pay for was
  // charged as the metres you actually hang.
  let cable = 0;
  let designOnly = 0;
  for (const line of bom.lines) {
    cable += line.purchaseM * COSTS.cablePerM[line.model];
    designOnly += line.designM * COSTS.cablePerM[line.model];
  }
  const expected = cable + COSTS.splice * w.candidate.metrics.splices +
    COSTS.closure * w.candidate.metrics.closures + COSTS.splitter * w.candidate.metrics.splitters;

  close(w.candidate.metrics.cost, expected, 0.01, 'cost is the priced purchase plus the priced plant');
  assert.ok(cable > designOnly, 'the drums cost more than the metres hung, or this test proves nothing');
});

test('the money verdict carries its arithmetic, and the terms add up to the total', function () {
  const w = winner(30);
  const b = w.candidate.metrics.costBreakdown;
  assert.ok(b, 'a money objective reports what it spent');
  close(b.cable, w.candidate.bom.lines.reduce(function (n, l) {
    return n + l.purchaseM * COSTS.cablePerM[l.model];
  }, 0), 0.01, 'the cable term is the priced drums, per model');
  assert.strictEqual(b.splices, COSTS.splice * w.candidate.metrics.splices);
  assert.strictEqual(b.closures, COSTS.closure * w.candidate.metrics.closures);
  assert.strictEqual(b.splitters, COSTS.splitter * w.candidate.metrics.splitters);
  close(b.total, b.cable + b.splices + b.closures + b.splitters, 0.01, 'the terms sum to the total');
  assert.strictEqual(b.total, w.candidate.metrics.cost, 'the breakdown is the ranked number, not a second guess');

  // The chosen design's own summary is what a caller reads, so it carries the same arithmetic.
  const best = w.out.best;
  assert.strictEqual(best.metrics.cost, w.candidate.metrics.cost);
  assert.strictEqual(JSON.stringify(best.metrics.costBreakdown), JSON.stringify(b));
});

test('with no cost model there is no cost and no breakdown - not a zero', function () {
  const out = engine.design.synthesise(street(12, 0.0004), { headEnd: HEAD_END }, registry);
  assert.strictEqual(out.objective, 'fibre-metres');
  assert.strictEqual(out.best.metrics.cost, null);
  assert.strictEqual(out.best.metrics.costBreakdown, null);
});

test('a design that fits a single drum ties on cable cost, and the next term breaks the tie', function () {
  // Two drops on one 1 km drop drum: both buy 1000 m of g657a2-drop-1 at 0.4/m = 400, whatever
  // their measured metres. Pricing design metres made the shorter run look cheaper by the metres it
  // saved on a drum that is bought whole; the cost now ties and cable metres decide.
  const costs = { cablePerM: { 'g657a2-drop-1': 0.4, 'g657a2-drop-2': 0.6, 'g652d-loose-12': 1.1, 'g652d-loose-24': 2.0 } };
  const out = engine.design.synthesise(street(4, 0.0008), { headEnd: HEAD_END, costs: costs, technology: 'pon' }, registry);
  const feasible = out.candidates.filter(function (c) { return c.feasible; });
  assert.ok(feasible.length >= 1, 'at least one PON candidate');
  for (const c of feasible) {
    const cable = c.bom.lines.reduce(function (n, l) {
      return n + l.purchaseM * (costs.cablePerM[l.model] || 0);
    }, 0);
    const drums = c.bom.lines.reduce(function (n, l) { return n + l.drums; }, 0);
    assert.strictEqual(c.metrics.costBreakdown.cable, cable,
      c.label + ': cable is ' + drums + ' drum(s) priced, not ' + c.metrics.designM + ' m');
  }
});

done();
