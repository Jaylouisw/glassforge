'use strict';
// #39: the splitter site is a demand point, so the distribution tree's root edge measured 0 m and was
// emitted as a 1 m cable run. Fifteen fibres on that edge sent `cableFor` to the 24-fibre rung, and the
// bill of materials rounds drums once per cable model - so two 1 m stubs bought one 2000 m drum of
// 24-fibre cable for 2 m of cable, and a `costs` model charged it against every PON candidate.
//
// The decision (issue #39, the "no stub span" option): the splitter's outputs terminate on the
// distribution fibres inside the closure the splitter already sits in, so the first branch closure at
// the splitter's own coordinate is not a second box and there is no cable between the two ends of one
// point. The edge is contracted - `emitTerminalTree` maps that branch onto the splitter's closure and
// emits no span - and the trace from splitter to ONT starts one edge further out.
//
// The cost of the contraction is optical and deliberate: the path used to cross two closures at the
// site (the feeder closure and the duplicate branch closure) where the plant has one box, so every ODN
// on an auto-designed PON is 0.10 dB lower than it was. That is asserted below as arithmetic, not as a
// remembered number.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

// 30 houses on a 6 x 5 grid ~0.001 deg apart, head-end on the first house: the seed #39 measured.
function grid() {
  const points = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 6; c++) {
      points.push({ label: 'House ' + (r * 6 + c + 1), lat: 51.4985 + r * 0.001, lon: -0.1004 + c * 0.001 });
    }
  }
  return points;
}

const HEAD_END = { lat: 51.4985, lon: -0.1004, name: 'PoP' };
const PON = { ratios: [16] };

// Prices are per metre of the drum actually bought: 12F 1.00, 24F 1.60, drop-1 0.30, drop-2 0.40.
const COSTS = {
  cablePerM: { 'g652d-loose-12': 1, 'g652d-loose-24': 1.6, 'g657a2-drop-1': 0.3, 'g657a2-drop-2': 0.4 },
  closure: 0, splice: 0, splitter: 0
};

const designed = engine.design.synthesise(grid(), { headEnd: HEAD_END, technology: 'pon', pon: PON }, registry);
const money = engine.design.synthesise(grid(), { headEnd: HEAD_END, technology: 'pon', pon: PON, costs: COSTS }, registry);

function winner(result) {
  const best = result.candidates.filter(function (c) { return c.label === result.best.label; })[0];
  assert.ok(best, 'the winning candidate is not in the table: ' + result.best.label);
  return best;
}

test('the splitter site is one box, so no distribution cable is bought between its two ends', function () {
  const stubs = designed.plant.spans.filter(function (s) {
    return s.purpose === 'distribution' && s.lengthM <= 1;
  });
  assert.deepStrictEqual(stubs, [],
    'a 1 m distribution span is the site duplicated as a second closure, not a run: ' + JSON.stringify(stubs));
  // The model the stub used to force: 15 fibres cannot ride the 12-fibre rung, so it bought the next.
  const trunk = designed.plant.spans.filter(function (s) { return s.cable === 'g652d-loose-24'; });
  assert.deepStrictEqual(trunk, [], 'nothing on this design needs 24-fibre cable: ' + JSON.stringify(trunk));
  // Still a PON with a splitter per site, one per cluster of 15 houses.
  assert.strictEqual(designed.plant.nodes.filter(function (n) { return n.type === 'splitter'; }).length, 2);
  assert.deepStrictEqual(engine.network.validate(designed.plant, registry).errors, []);
});

test('the bill of materials carries no stub drum, and the cable cost says so', function () {
  const best = winner(money);
  const models = best.bom.lines.map(function (line) { return line.model; });
  assert.strictEqual(models.indexOf('g652d-loose-24'), -1, 'no 24-fibre line: ' + JSON.stringify(models));
  // Two 2000 m drums of 12F at 1.00 = 4000; one 1000 m drum of drop-1 at 0.30 = 300; one of drop-2 at
  // 0.40 = 400. Total 4700. The 24F drum the stub used to add was designM 2 m -> one 2000 m drum at
  // 1.60 = 3200, i.e. 30% of the cable cost of the whole design for 2 m of cable.
  close(best.metrics.costBreakdown.cable, 4700, 0.01, 'cable cost');
  assert.strictEqual(best.metrics.costBreakdown.cable,
    best.bom.lines.reduce(function (n, line) { return n + line.purchaseM * COSTS.cablePerM[line.model]; }, 0),
    'the breakdown is the sum of the lines it is built from');
});

test('every ONT still walks its splitter, at the ODN its own path costs', function () {
  const best = winner(designed);
  assert.strictEqual(best.budgets.length, 30);
  best.budgets.forEach(function (row) {
    assert.ok(!row.error, row.name + ': ' + row.error);
    assert.notStrictEqual(row.verdict, 'fail', row.name + ': ' + (row.marginalReason || ''));
    const path = engine.network.trace(designed.plant, row.ont);
    const splitters = path.nodes.filter(function (n) { return n.type === 'splitter'; });
    assert.strictEqual(splitters.length, 1, row.name + ' crosses ' + splitters.length + ' splitters, not one');
  });
  // House 9 sits on the site, so its path is the shortest: 213.1 m of 12F feeder + the 1 m splitter tail
  // + its 1 m drop, all at 0.22 dB/km = 0.047 dB; one splice at the closure + the splitter's spliced
  // input tail = 0.20 dB; the 1:16 PLC is 12.04 split + 1.76 excess = 13.80 dB; two SC/APC connectors
  // at 0.30 = 0.60 dB. 0.047 + 0.20 + 13.80 + 0.60 = 14.647 dB.
  const site = engine.network.allOntBudgets(designed.plant, registry)
    .filter(function (row) { return row.name === 'House 9'; })[0];
  assert.ok(site, 'no budget row for the house on the splitter site');
  assert.ok(site.result, 'the site house was not budgeted: ' + site.error);
  close(site.result.odnLossDb, 14.647, 0.002, 'site-house ODN');
});

test('a distribution run the router measured is still a cable purchase', function () {
  // The contraction is about a run of *nothing*. Routed along a street graph the tree root and the
  // first branch are different nodes, so the distribution cable is real and must still be bought.
  const main = [];
  for (let i = 0; i <= 10; i++) main.push({ lat: 51.5, lon: -0.1010 + i * 0.0002 });
  const houses = [];
  for (let i = 2; i <= 9; i++) houses.push({ label: 'House ' + i, lat: 51.5, lon: -0.1010 + i * 0.0002 });
  const routed = engine.design.synthesise(houses, {
    headEnd: { lat: 51.5, lon: -0.1010, name: 'PoP' },
    technology: 'pon',
    network: { edges: [{ id: 'main', coords: main }] }
  }, registry);
  assert.strictEqual(routed.routeMethod.indexOf('street-graph'), 0, routed.routeMethod);
  const runs = routed.plant.spans.filter(function (s) { return s.purpose === 'distribution'; });
  assert.ok(runs.length > 0, 'the routed design has no distribution cable at all');
  runs.forEach(function (s) {
    assert.ok(s.lengthM > 1, 'a routed distribution run of ' + s.lengthM + ' m is not a stub: ' + s.id);
  });
  assert.deepStrictEqual(engine.network.validate(routed.plant, registry).errors, []);
});

test('an active tree is untouched: a house on the head-end keeps its 1 m drop', function () {
  // `contractCoincidentRoot` is asked for by the PON distribution builder alone. An active plant has no
  // splitter site to contract, and a house at the head-end's own coordinate still needs its drop span.
  const out = engine.design.synthesise([{ label: 'Shed', lat: 51.5, lon: -0.1 }], {
    headEnd: { lat: 51.5, lon: -0.1, name: 'DC' },
    technology: 'active',
    active: { optics: [{ headEndOptic: 'sfp-plus-10g-lr-10km', cpeOptic: 'sfp-plus-10g-lr-10km' }] }
  }, registry);
  // Whichever active topology wins (one house is a home-run), the span from the head-end is kept: the
  // contraction would have deleted it as a "0 m edge", which is why it is scoped to PON distribution.
  assert.strictEqual(out.plant.spans.length, 1, JSON.stringify(out.plant.spans));
  assert.strictEqual(out.plant.spans[0].lengthM, 1, 'the shortest span this model accepts is 1 m');
  assert.strictEqual(out.plant.spans[0].cable, 'g657a2-drop-2');
});

done();
