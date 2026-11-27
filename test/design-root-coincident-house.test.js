'use strict';
// An auto-designed PON roots each distribution tree on its splitter site, and a site is a *house*
// (the k-means medoid), so the tree has an edge from the root to a point at the same coordinates.
// `euclidTree` measured that edge at 0 m and lifted it to the 1 m floor, so the design emitted a
// 1 m "distribution" span carrying every fibre in the cluster. `cableFor` then found the 24-fibre
// trunk for it, and the BOM - which rounds drums once per model - bought a 2000 m drum of 24F for
// 2 m of cable (gh#39). The street provider never does this: a terminal that snaps to the root node
// attaches to the root and no zero-length edge is emitted. The straight-line provider now agrees.
const { test, assert, close } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

// 30 houses on a 6 x 5 grid 0.001 deg apart (about 111 m), head-end west of the grid. K-means splits
// them into two 15-house 1:16 sites, and each site's medoid is a house in the grid.
function grid() {
  const points = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 6; col++) {
      points.push({
        id: 'h' + (row * 6 + col + 1),
        label: 'House ' + (row * 6 + col + 1),
        lat: 51.4985 + row * 0.001,
        lon: -0.1039 + col * 0.001
      });
    }
  }
  return points;
}

const HEAD_END = { lat: 51.4985, lon: -0.1004, name: 'PoP' };

function design() {
  const out = engine.design.synthesise(grid(), {
    headEnd: HEAD_END, technology: 'pon', pon: { ratios: [16] }
  }, registry);
  assert.strictEqual(out.candidates.length, 1, 'one PON candidate');
  assert.strictEqual(out.candidates[0].feasible, true, 'the 1:16 design is feasible');
  return out.candidates[0];
}

test('a splitter site rooted on a house emits no distribution span for the inside of the closure', function () {
  const candidate = design();
  // The splitter stands on a house, the medoid: the edge from root to that point is 0 m, not a run.
  // A distribution span at the 1 m floor that feeds more than one ONT is that phantom span - 15
  // fibres of 24F cable for the inside of a closure.
  const phantom = candidate.plant.spans.filter(function (span) {
    return span.purpose === 'distribution' && span.lengthM <= 1 && span.feedsOnts > 1;
  });
  assert.deepStrictEqual(phantom.map(function (span) { return span.id; }), [],
    'a 1 m distribution span cannot feed 15 houses - the splitter site is the house');
});

test('the house at the splitter site is served by its own drop from the splitter', function () {
  const candidate = design();
  const splitters = candidate.plant.nodes.filter(function (n) { return n.type === 'splitter'; });
  assert.strictEqual(splitters.length, 2, 'two splitter sites');
  for (const splitter of splitters) {
    const house = candidate.plant.nodes.filter(function (n) {
      return n.type === 'ont' && n.lat === splitter.lat && n.lon === splitter.lon;
    });
    assert.strictEqual(house.length, 1, 'one ONT at ' + splitter.id);
    const drop = candidate.plant.spans.filter(function (span) {
      return span.purpose === 'drop' && span.to === house[0].id;
    });
    assert.strictEqual(drop.length, 1, house[0].id + ' has exactly one drop');
    // The drop is 1 m of 1-fibre drop cable, not a 15-fibre 24F trunk: the shortest drop that can
    // physically exist, the same figure the splitter tail uses.
    assert.strictEqual(drop[0].from, splitter.id, house[0].id + ' drops from the splitter');
    assert.strictEqual(drop[0].lengthM, 1);
    assert.deepStrictEqual(drop[0].strands, [1]);
    assert.strictEqual(drop[0].cable, 'g657a2-drop-1');
  }
});

test('the BOM buys no 24-fibre cable for a design that never leaves 12 fibres', function () {
  const candidate = design();
  const models = candidate.bom.lines.map(function (line) { return line.model; });
  // Two 15-fibre clusters fed on 12F cable (two bundles): no distribution run needs more than 12
  // fibres, so a 24F line can only be the 1 m phantom span. Before gh#39 this BOM carried
  // `g652d-loose-24` at 2.06 m of design length bought as one 2000 m drum, 30 % of the cable cost.
  assert.deepStrictEqual(models, ['g652d-loose-12', 'g657a2-drop-1', 'g657a2-drop-2']);
  for (const line of candidate.bom.lines) {
    assert.ok(line.designM > 10, line.model + ' is bought for ' + line.designM + ' m of design length');
  }
  // The rest of the plant is untouched: contracting a 0 m edge removes a span, it does not re-shape
  // the tree. 64 spans and 3070.6 m before, two 1 m phantom spans and their two closures gone.
  assert.strictEqual(candidate.metrics.spans, 62, JSON.stringify(candidate.metrics));
  assert.strictEqual(candidate.metrics.closures, 30, JSON.stringify(candidate.metrics));
  close(candidate.metrics.designM, 3068.6, 0.2, 'design length');
});

test('every house is still designed and still budgets to an ok verdict', function () {
  const candidate = design();
  const onts = candidate.plant.nodes.filter(function (n) { return n.type === 'ont'; });
  assert.strictEqual(onts.length, 30, 'one ONT per house');
  assert.strictEqual(candidate.budgets.length, 30, 'one budget per ONT');
  const failing = candidate.budgets.filter(function (b) { return b.verdict !== 'ok'; });
  assert.deepStrictEqual(failing.map(function (b) { return b.ont + ':' + b.verdict; }), []);
});

