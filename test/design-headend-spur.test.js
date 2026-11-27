'use strict';
// The head end is a site on the map too: the metres from the exchange to the nearest street are
// cable somebody buys. Every *customer* gap is already a drop span (`spurM`); the head end is the one
// terminal that is not in the demand list, so nothing covered its gap and the span that left the
// head-end node was shorter than the route drawn between the same two coordinates.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');
const street = engine.street;
const geo = engine.geo;

const registry = engine.createRegistry();

// One straight main street at 51.5000, 0.0020 deg of longitude (about 139 m) between its ends.
function network() {
  return { edges: [{ id: 'main', coords: [{ lat: 51.5, lon: -0.1010 }, { lat: 51.5, lon: -0.0990 }] }] };
}
const ON_STREET = { lat: 51.5, lon: -0.1010, name: 'PoP' };
// 0.0006 deg of latitude north of the street's west end: 66.7 m of driveway, no vertex, no street.
const OFF_STREET = { lat: 51.5006, lon: -0.1010, name: 'PoP' };
const DEMAND = [{ lat: 51.5, lon: -0.1005 }, { lat: 51.5, lon: -0.1000 }];

const GAP_M = geo.distanceM(ON_STREET, OFF_STREET);

function design(headEnd) {
  return engine.design.synthesise(DEMAND, { headEnd: headEnd, network: network(), technology: 'active', includeAllPlants: true }, registry);
}
function candidate(result, label) {
  const found = result.candidates.filter(function (c) { return c.label.indexOf(label) === 0; })[0];
  assert.ok(found, 'candidate "' + label + '" is in the comparison');
  return found;
}

test('the head end is 66.7 m off the street, and the snap measures it', function () {
  // 0.0006 deg of latitude x 111,132 m/deg = 66.68 m.
  close(GAP_M, 66.7, 0.3, 'the head-end gap');
  const graph = street.buildGraph(network());
  close(street.snap(graph, OFF_STREET).spurM, GAP_M, 0.2, 'the snap reports the gap');
  close(street.snap(graph, ON_STREET).spurM, 0, 0.2, 'a head end on the street has no gap');
});

test('one cable per customer: every home-run span crosses the head-end gap', function () {
  const on = design(ON_STREET);
  const off = design(OFF_STREET);
  const onRun = candidate(on, 'Active Ethernet, one cable per customer');
  const offRun = candidate(off, 'Active Ethernet, one cable per customer');
  // Two cables leave the exchange, so two gaps are bought: 2 x 66.68 m.
  close(offRun.metrics.cableM - onRun.metrics.cableM, 2 * GAP_M, 1.5,
    'two home-run cables, each across the gap');
  for (const span of offRun.plant.spans) {
    assert.ok(span.lengthM > GAP_M, 'span ' + span.id + ' is at least the gap, got ' + span.lengthM);
    // The span starts at the head-end node, so the drawn route has to start there too.
    close(geo.pathLengthM(span.route), span.lengthM, 1.5, 'drawn route of ' + span.id);
  }
});

test('a shared tree buys the gap once, on the cable that leaves the head end', function () {
  const on = design(ON_STREET);
  const off = design(OFF_STREET);
  const onTree = candidate(on, 'Active Ethernet over a shared cable tree');
  const offTree = candidate(off, 'Active Ethernet over a shared cable tree');
  close(offTree.metrics.cableM - onTree.metrics.cableM, GAP_M, 1.5, 'one trunk, one gap');
  const rootSpan = offTree.plant.spans.filter(function (s) { return s.from === 'n-headend'; })[0];
  assert.ok(rootSpan, 'the tree has a span from the head end');
  close(geo.pathLengthM(rootSpan.route), rootSpan.lengthM, 1.5, 'drawn route of the root trunk');
});

test('a PON feeder charges the gap once, and the splitter site is not charged twice', function () {
  const ponOn = engine.design.synthesise(DEMAND, { headEnd: ON_STREET, network: network(), technology: 'pon', includeAllPlants: true }, registry);
  const ponOff = engine.design.synthesise(DEMAND, { headEnd: OFF_STREET, network: network(), technology: 'pon', includeAllPlants: true }, registry);
  const on = candidate(ponOn, 'PON 1:8');
  const off = candidate(ponOff, 'PON 1:8');
  // The splitter site is the first house, so its own gap is already its drop span. Only the feeder's
  // head-end end gains the 66.68 m; charging the site's gap again would add a second 0 m.
  close(off.metrics.cableM - on.metrics.cableM, GAP_M, 1.5, 'the head-end gap, once');
  const feeder = off.plant.spans.filter(function (s) { return s.purpose === 'feeder' && s.from === 'n-headend'; })[0];
  assert.ok(feeder, 'the feeder leaves the head end');
  close(geo.pathLengthM(feeder.route), feeder.lengthM, 1.5, 'drawn feeder route');
});

test('every routed span is drawn as long as it is billed', function () {
  for (const headEnd of [ON_STREET, OFF_STREET]) {
    const result = engine.design.synthesise(DEMAND, { headEnd: headEnd, network: network(), includeAllPlants: true }, registry);
    for (const c of result.candidates) {
      if (!c.plant) continue;
      for (const span of c.plant.spans) {
        if (!span.route || span.purpose === 'splitter-tail') continue;
        close(geo.pathLengthM(span.route), span.lengthM, 1.5,
          c.label + ' / ' + span.id + ' billed ' + span.lengthM + ' m');
      }
    }
  }
});

done();
