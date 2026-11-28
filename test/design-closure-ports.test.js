'use strict';
// The box a design buys has to take the cables that reach it.
//
// `closureModelFor(degree)` chose by the tree degree alone, and fell through to `mufa-inline-24`
// for anything above 16. The mufa is a straight-through in-line joint with **four** cable ports - a
// 20-way junction was designed into 20 cables into 4 ports, ranked `feasible`, and bought that way.
// The catalogue has carried `nap-24` (26 ports: 24 drops and two feeder entries) since it was added,
// and no engine path ever chose it. The count is also not the degree: every cable in a bundle enters
// the box (`splicesAtClosure` counts the same way since gh#114), so a three-way node fed by 2 x 12F
// is six cables at the tray, not three.
//
// These tests drive a street-star fixture through `design.synthesise` and read the closure the plant
// actually bought: the model's `ports` must be at least the cables touching the node, and the big
// junction must be a NAP, not a four-port dome.
const { test, assert } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const LAT_M = 111132.95;

const HUB = { lat: 51.5, lon: 0 };
const HEAD_END = { lat: 51.5, lon: -0.004 };

function bearingOf(edgeIndex, spokeCount) {
  // Half a step off the spine so no spoke lies along it: the hub is then 20 spokes plus the spine,
  // not 19 plus a collinear pair merged into one edge.
  return ((edgeIndex + 0.5) / spokeCount) * 2 * Math.PI;
}

function offset(metres, bearing) {
  return {
    lat: HUB.lat + (Math.cos(bearing) * metres) / LAT_M,
    lon: HUB.lon + (Math.sin(bearing) * metres) / (LAT_M * Math.cos((HUB.lat * Math.PI) / 180))
  };
}

// A star of `spokeCount` streets meeting at one point, plus the spine the head end sits on. A
// junction is the ordinary case in imported geometry: a duct chamber or an intersection where many
// ways meet, and the tree the router builds has that many edges.
function star(spokeCount) {
  const edges = [{
    id: 'spine',
    coords: [{ lat: HEAD_END.lat, lon: HEAD_END.lon }, { lat: HUB.lat, lon: HUB.lon }]
  }];
  for (let i = 0; i < spokeCount; i++) {
    edges.push({ id: 'spoke' + i, coords: [{ lat: HUB.lat, lon: HUB.lon }, offset(200, bearingOf(i, spokeCount))] });
  }
  return { edges: edges };
}

function houseOn(edgeIndex, spokeCount, at, id) {
  const point = offset(200, bearingOf(edgeIndex, spokeCount));
  // `at` is the fraction of the 200 m spoke the house sits at; the point is on the polyline, so the
  // snap measures 0 m and the tree edge carries it.
  return { id: id, label: id, lat: HUB.lat + (point.lat - HUB.lat) * at, lon: HUB.lon + (point.lon - HUB.lon) * at };
}

function cablesAt(plant, registry) {
  const cables = new Map();
  for (const span of plant.spans) {
    const count = span.bundles || 1;
    cables.set(span.from, (cables.get(span.from) || 0) + count);
    cables.set(span.to, (cables.get(span.to) || 0) + count);
  }
  const rows = plant.nodes.filter(function (n) { return n.type === 'closure'; }).map(function (n) {
    const part = registry.get('closure', n.model);
    return { id: n.id, model: n.model, ports: part.ports, cables: cables.get(n.id) || 0 };
  });
  return rows.sort(function (a, b) { return b.cables - a.cables; });
}

function treeCandidate(result) {
  const found = result.candidates.filter(function (c) { return /over a shared cable tree/.test(c.label); })[0];
  assert.ok(found, 'the shared-tree candidate is in the comparison');
  assert.ok(found.plant, 'its plant is carried (includeAllPlants)');
  return found;
}

function starDemand(spokeCount, perSpoke) {
  const demand = [];
  for (let i = 0; i < spokeCount; i++) {
    for (let k = 1; k <= perSpoke; k++) demand.push(houseOn(i, spokeCount, perSpoke === 1 ? 1 : k / perSpoke, 'H' + i + '-' + k));
  }
  return demand;
}

test('a 20-way junction is bought as a NAP-24, not a four-port in-line mufa', function () {
  const out = engine.design.synthesise(starDemand(20, 1), {
    headEnd: HEAD_END, network: star(20), technology: 'active', includeAllPlants: true
  }, registry);
  assert.strictEqual(out.ok, true, 'the design ran');
  const rows = cablesAt(treeCandidate(out).plant, registry);
  // 20 spokes plus the spine meet at the hub, one cable each (2 fibres is a drop cable).
  assert.strictEqual(rows[0].cables, 21, JSON.stringify(rows.slice(0, 3)));
  assert.strictEqual(rows[0].model, 'nap-24', 'the junction box: ' + rows[0].model);
  assert.ok(rows[0].ports >= rows[0].cables,
    rows[0].ports + ' ports for ' + rows[0].cables + ' cables');
});

test('every closure the design buys has ports for the cables that reach it', function () {
  const out = engine.design.synthesise(starDemand(20, 1), {
    headEnd: HEAD_END, network: star(20), technology: 'active', includeAllPlants: true
  }, registry);
  const short = cablesAt(treeCandidate(out).plant, registry)
    .filter(function (r) { return r.ports < r.cables; })
    .map(function (r) { return r.id + ' ' + r.model + ': ' + r.cables + ' cables into ' + r.ports + ' ports'; });
  assert.deepStrictEqual(short, []);
});

test('a bundled feeder is counted as its cables, not as its edges', function () {
  // Three spokes, ten houses on each, on a 12-fibre ladder: a spoke edge carries 20 fibres, i.e.
  // two cables, and the spine carries 60, i.e. five. Eleven cables meet at the hub - more than the
  // nine ports of the NAP-8 the degree (4) used to choose.
  const out = engine.design.synthesise(starDemand(3, 10), {
    headEnd: HEAD_END, network: star(3), technology: 'active', includeAllPlants: true,
    ladder: ['g652d-loose-12']
  }, registry);
  const rows = cablesAt(treeCandidate(out).plant, registry);
  assert.strictEqual(rows[0].cables, 11, JSON.stringify(rows.slice(0, 3)));
  assert.ok(rows[0].ports >= rows[0].cables,
    rows[0].model + ': ' + rows[0].ports + ' ports for ' + rows[0].cables + ' cables');
  assert.strictEqual(rows[0].model, 'nap-16', 'the eleven-cable box: ' + rows[0].model);
});

test('an ordinary PON site still buys the NAP-8 it always did', function () {
  // Regression guard, not a new claim: two feeder legs and the splitter tail are three cables, and
  // nap-8 is the box for eight drops and their feeder.
  const demand = [
    { id: 'a', label: 'a', lat: 51.5010, lon: 0.0002 },
    { id: 'b', label: 'b', lat: 51.5011, lon: 0.0001 },
    { id: 'c', label: 'c', lat: 51.5009, lon: 0.0000 }
  ];
  const out = engine.design.synthesise(demand, {
    headEnd: HEAD_END, network: star(4), technology: 'pon', pon: { ratios: [8] }, includeAllPlants: true
  }, registry);
  assert.strictEqual(out.ok, true, 'the PON design ran');
  const pon = out.candidates.filter(function (c) { return c.technology === 'pon'; })[0];
  assert.ok(pon && pon.plant, 'the PON candidate carries its plant');
  const rows = cablesAt(pon.plant, registry);
  const feederClosure = rows.filter(function (r) { return /^fc-/.test(r.id); })[0];
  assert.ok(feederClosure, 'the feeder closure is in the plant: ' + rows.map(function (r) { return r.id; }).join(', '));
  assert.strictEqual(feederClosure.model, 'nap-8', 'the site closure: ' + feederClosure.model);
});
