'use strict';
// A splitter site is a *house* - the cluster's medoid - so an estate with a building at the
// head-end's own street vertex has a site that stands on the root. `emitTerminalTree` already treats
// a terminal that snaps onto the tree root as attached to it (gh#39), but the *feeder* tree skipped
// the root node outright: no closure, no splitter, no 1 m tail, so `cfg.splitterPlantId` never
// learned the site. `buildPon` read that as "the site did not resolve" and refused the candidate with
// the houses named as unreachable - measured on this engine, two houses on one 333 m street with one
// of them on the head-end answered "2 address(es) are not on the street network or not reachable
// along it: d1, d2", while the same demand with no network designed at 416.4 m. The defence was
// `street.routedTree` attaching the site to the root, which is correct; the emitter dropped it.
const { test, assert, close } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

const HEAD_END = { lat: 51.5, lon: -0.10, name: 'PoP' };
// 0.003 deg of latitude at 51.5 is 333.58 m: one street, the head-end at its west end.
const STREET = { edges: [{ id: 'main', coords: [{ lat: 51.5, lon: -0.10 }, { lat: 51.503, lon: -0.10 }] }] };
// The exchange building is also a customer, and the next house is at the far end of the street.
const DEMAND = [
  { label: 'Exchange House', lat: 51.5, lon: -0.10 },
  { label: 'House 2', lat: 51.503, lon: -0.10 }
];

function design(extra) {
  const out = engine.design.synthesise(DEMAND, Object.assign({
    headEnd: HEAD_END, technology: 'pon', pon: { ratios: [16] }
  }, extra || {}), registry);
  assert.strictEqual(out.candidates.length, 1, 'one 1:16 candidate');
  return out.candidates[0];
}

function spans(candidate) {
  return candidate.plant.spans;
}

function nodesOf(candidate, type) {
  return candidate.plant.nodes.filter(function (n) { return n.type === type; });
}

test('a splitter site on the head-end vertex designs instead of being refused as unreachable', function () {
  const candidate = design({ network: STREET });
  assert.strictEqual(candidate.feasible, true,
    'the site stands on the network, so the candidate is buildable: ' + JSON.stringify(candidate.reasons));
  assert.strictEqual(candidate.metrics.onts, 2, 'both houses are designed');
});

test('the site keeps a closure and a splitter at the root, on a 1 m tail', function () {
  const candidate = design({ network: STREET });
  const splitters = nodesOf(candidate, 'splitter');
  assert.strictEqual(splitters.length, 1, 'one splitter site');
  assert.strictEqual(splitters[0].lat, HEAD_END.lat, 'the site is the medoid, which is the house at the head-end');
  assert.strictEqual(splitters[0].lon, HEAD_END.lon);
  const tail = spans(candidate).filter(function (s) { return s.to === splitters[0].id; });
  assert.strictEqual(tail.length, 1, 'one tail into the splitter');
  assert.strictEqual(tail[0].purpose, 'splitter-tail');
  // The 1 m span floor, the same figure the straight-line provider uses for a site that stands on
  // its own splitter (gh#39): the shortest drop that can physically exist.
  assert.strictEqual(tail[0].lengthM, 1);
});

test('the OLT reaches that closure by a 1 m patch, so the plant is one tree', function () {
  const candidate = design({ network: STREET });
  const fromHeadEnd = spans(candidate).filter(function (s) { return s.from === 'n-headend'; });
  assert.strictEqual(fromHeadEnd.length, 1, 'exactly one cable leaves the OLT: ' + JSON.stringify(fromHeadEnd.map(function (s) { return s.id; })));
  // The site posts 0 m from the OLT: there is no duct, and the patch is the 1 m span floor rather
  // than a straight line drawn across a distance nothing measured.
  assert.strictEqual(fromHeadEnd[0].lengthM, 1);
  assert.strictEqual(fromHeadEnd[0].purpose, 'feeder');
  assert.strictEqual(fromHeadEnd[0].route, null, 'a 0 m gap has no geometry to draw');
  // Every node is reachable from the OLT, which is what a plant means.
  const check = engine.network.validate(candidate.plant, registry);
  assert.deepStrictEqual(check.errors, [], 'the plant validates');
});

test('the house on the head-end is served by its own 1 m drop, from the splitter', function () {
  const candidate = design({ network: STREET });
  const splitter = nodesOf(candidate, 'splitter')[0];
  const house = nodesOf(candidate, 'ont').filter(function (n) {
    return n.lat === HEAD_END.lat && n.lon === HEAD_END.lon;
  });
  assert.strictEqual(house.length, 1, 'one ONT at the head-end coordinates');
  const drop = spans(candidate).filter(function (s) { return s.to === house[0].id; });
  assert.strictEqual(drop.length, 1, 'one drop');
  assert.strictEqual(drop[0].from, splitter.id, 'the drop is from the splitter, not the OLT');
  assert.strictEqual(drop[0].lengthM, 1);
  assert.deepStrictEqual(drop[0].strands, [1]);
  const budget = candidate.budgets.filter(function (b) { return b.ont === house[0].id; })[0];
  assert.strictEqual(budget.verdict, 'ok', JSON.stringify(budget));
});

test('the street and straight-line providers emit the same shape for a site on the head-end', function () {
  const street = design({ network: STREET });
  const straight = design();
  // A 0.003 deg lat step measures 333.58 m on the sphere: the street route is 333.59 m and the
  // straight line is multiplied by the default route factor 1.2 (333.58 x 1.2 = 400.3 m). Both
  // designs are 1 m tail + 1 m patch + 1 m drop + the run, then 3 % overlength:
  //   street    (1 + 1 + 1 + 1 + 333.59) x 1.03 = 347.7 m
  //   straight  (1 + 1 + 1 + 1 + 400.30) x 1.03 = 416.4 m
  close(street.metrics.designM, 347.7, 0.2, 'street design length');
  close(straight.metrics.designM, 416.4, 0.2, 'straight design length');
  for (const candidate of [street, straight]) {
    assert.strictEqual(nodesOf(candidate, 'splitter').length, 1, 'one splitter site');
    assert.strictEqual(nodesOf(candidate, 'closure').length, 2, 'the site closure and the far closure');
    const patch = spans(candidate).filter(function (s) { return s.from === 'n-headend'; })[0];
    assert.strictEqual(patch.lengthM, 1, 'the provider that stands the site on the OLT bills 1 m');
  }
});
