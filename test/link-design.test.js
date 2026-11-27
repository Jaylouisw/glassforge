'use strict';
// Site-to-site links: two legs routed along a duct graph, diversity stated, leased segments excluded
// from the cable BOM, and one budget verdict per leg.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const link = engine.link;

function p(lat, lon) { return { lat: lat, lon: lon }; }

const A = { name: 'DC-West', lat: 51.5000, lon: -0.1020 };
const B = { name: 'DC-East', lat: 51.5000, lon: -0.0960 };
const ER = { a: 'sfp-plus-10g-er-40km', b: 'sfp-plus-10g-er-40km' };

// A block with no crossing: A and B sit on the same latitude 415.3 m apart, but the street between
// them does not exist, so the only routes are up to the north street or down to the south one.
function grid() {
  return { edges: [
    { id: 'north', coords: [p(51.5010, -0.1020), p(51.5010, -0.0960)] },
    { id: 'south', coords: [p(51.4995, -0.1020), p(51.4995, -0.0960)] },
    { id: 'a-north', coords: [p(51.5000, -0.1020), p(51.5010, -0.1020)] },
    { id: 'a-south', coords: [p(51.5000, -0.1020), p(51.4995, -0.1020)] },
    { id: 'b-north', coords: [p(51.5000, -0.0960), p(51.5010, -0.0960)] },
    { id: 'b-south', coords: [p(51.5000, -0.0960), p(51.4995, -0.0960)] }
  ] };
}

function gridLink(extra) {
  return link.design(Object.assign({ sites: { a: A, b: B }, network: grid(), optics: ER }, extra || {}), registry);
}

test('both legs are routed along the streets, round the junction, not across the block', function () {
  const r = gridLink();
  // 0.006 deg of longitude at 51.5 is 415.3 m; 0.0005 deg of latitude is 55.6 m and 0.001 deg is
  // 111.2 m. South leg = 415.3 + 2 x 55.6 = 526.5 m, north leg = 415.3 + 2 x 111.2 = 637.7 m.
  // The straight line A->B is 415.3 m, so either routed length proves the route went round the block.
  close(r.legs[0].routedM, 526.5, 0.3, 'south leg');
  close(r.legs[1].routedM, 637.7, 0.3, 'north leg');
  const straight = engine.geo.distanceM(A, B);
  close(straight, 415.3, 0.5, 'straight line A->B');
  assert.ok(r.legs[0].routedM > straight + 100, 'a street-routed leg must not equal the chord');
  assert.ok(r.routeMethod.indexOf('street-graph') === 0, r.routeMethod);
  // The geometry is the street: each leg turns at the corner it used, at 51.5010 or 51.4995.
  const corners = r.legs.map(function (leg) {
    return leg.route.some(function (point) {
      return Math.abs(point.lat - 51.5010) < 1e-6 || Math.abs(point.lat - 51.4995) < 1e-6;
    });
  });
  assert.ok(corners[0] && corners[1], 'both legs keep their corner geometry');
});

test('the two legs are edge-disjoint and the report says 0 m shared', function () {
  const r = gridLink();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.protection.achieved, true);
  assert.strictEqual(r.diversity.sharedM, 0);
  assert.strictEqual(r.diversity.shared.length, 0);
  const a = new Set(r.paths[0].edges);
  const b = new Set(r.paths[1].edges);
  for (const edgeId of a) assert.ok(!b.has(edgeId), edgeId + ' is on both legs');
  assert.ok(r.diversity.sentence.indexOf('edge-disjoint') !== -1, r.diversity.sentence);
});

test('a ring graph gives two edge-disjoint legs of equal length', function () {
  const ring = { edges: [
    { id: 'AB', coords: [p(51.5, -0.1), p(51.5, -0.099)] },
    { id: 'BC', coords: [p(51.5, -0.099), p(51.509, -0.099)] },
    { id: 'CD', coords: [p(51.509, -0.099), p(51.509, -0.1)] },
    { id: 'DA', coords: [p(51.509, -0.1), p(51.5, -0.1)] }
  ] };
  const r = link.design({ sites: { a: { name: 'N', lat: 51.5, lon: -0.1 }, b: { name: 'S', lat: 51.509, lon: -0.099 } },
    network: ring, optics: ER }, registry);
  assert.strictEqual(r.diversity.sharedM, 0);
  // Ring: 69.6 m east + 1001.0 m north on either side = 1070.6 m, twice.
  close(r.legs[0].routedM, 1070.6, 1, 'first leg round the ring');
  close(r.legs[1].routedM, 1070.6, 1, 'second leg round the ring');
  assert.notStrictEqual(r.paths[0].edges.join(','), r.paths[1].edges.join(','));
});

test('a single-route graph reports the shared duct by name and metres', function () {
  const corridor = { edges: [{ id: 'duct', coords: [p(51.5, -0.1020), p(51.5, -0.0960)] }] };
  const r = link.design({ sites: { a: A, b: B }, network: corridor, optics: ER }, registry);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.protection.achieved, false);
  // The only route is the whole corridor: 415.3 m of it, shared end to end.
  close(r.diversity.sharedM, 415.3, 0.5, 'shared metres');
  assert.strictEqual(r.diversity.shared[0].edgeId, 'e1');
  assert.ok(r.diversity.sentence.indexOf('diverse except 415.3') === 0, r.diversity.sentence);
  assert.ok(r.warnings.some(function (w) { return w.indexOf('not diverse') !== -1; }), r.warnings.join(' | '));
});

test('the same input produces byte-identical legs', function () {
  const one = JSON.stringify(gridLink());
  const two = JSON.stringify(gridLink());
  assert.strictEqual(one, two);
});

test('a leased segment is budgeted, costed, and never bought as cable', function () {
  const r = gridLink({
    thirdParty: [{ provider: 'CityFibre', lengthM: 300, lossDb: 0.6, cost: 1200, leg: 'b', reference: 'CF-123' }]
  });
  const a = r.legs[0];
  const b = r.legs[1];
  close(a.lengthM, a.ownM, 0.001, 'the A-leg has no leased segment');
  close(b.leasedM, 300, 0.001, 'the B-leg carries the leased 300 m');
  close(b.lengthM, b.ownM + 300, 0.001, 'leased length is in the path length');
  assert.ok(b.budget.breakdown.some(function (line) { return line.kind === 'third-party' && line.db === 0.6; }),
    JSON.stringify(b.budget.breakdown));
  close(a.budget.thirdPartyLossDb, 0, 0.001, 'the A-leg carries no leased loss');
  close(b.budget.thirdPartyLossDb, 0.6, 0.001, 'the leased loss is charged to the leg that uses it');
  // Cable is the owned route only: the leased 300 m is not a purchase.
  close(r.bom.cableM, a.ownM + b.ownM, 0.01, 'cable metres exclude the leased segment');
  assert.strictEqual(r.bom.thirdParty.totalM, 300);
  assert.strictEqual(r.bom.thirdParty.cost, 1200);
  assert.strictEqual(r.bom.thirdParty.inCableBom, false);
  assert.strictEqual(r.thirdParty.segments[0].reference, 'CF-123');
});

test('a leased segment with no stated loss is refused, not assumed lossless', function () {
  throws(function () {
    gridLink({ thirdParty: [{ provider: 'CityFibre', lengthM: 300 }] });
  }, 'never assumed to be zero');
  throws(function () {
    gridLink({ thirdParty: [{ lengthM: 300, lossDb: 0.6 }] });
  }, 'names who owns it');
});

test('a route longer than the optic reaches is refused, naming the length and the reach', function () {
  const longNet = { edges: [{ id: 'trunk', coords: [p(51.0, -0.1), p(51.2, -0.1), p(51.45, -0.1)] }] };
  const r = link.design({
    sites: { a: { name: 'A', lat: 51.0, lon: -0.1 }, b: { name: 'B', lat: 51.45, lon: -0.1 } },
    network: longNet, optics: ER
  }, registry);
  // 0.45 deg of latitude = 50 038 m on a 40 km optic.
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.verdict, 'fail');
  assert.ok(r.reasons.some(function (x) { return x.indexOf('the route is 50038 m but the shorter optic reaches 40000 m') !== -1; }),
    r.reasons.join(' | '));
  assert.ok(r.reasons.every(function (x) { return x.indexOf('A-leg') === 0 || x.indexOf('B-leg') === 0; }),
    'every reason names the leg it belongs to');
});

test('a long-reach optic on a short run fails on overload, not on reach', function () {
  const shortNet = { edges: [{ id: 'cross', coords: [p(51.5, -0.1000), p(51.5, -0.0970)] }] };
  const r = link.design({
    sites: { a: { name: 'A', lat: 51.5, lon: -0.1000 }, b: { name: 'B', lat: 51.5, lon: -0.0970 } },
    network: shortNet, optics: { a: 'sfp-1g-zx-80km', b: 'sfp-1g-zx-80km' }
  }, registry);
  assert.strictEqual(r.verdict, 'fail');
  assert.ok(r.reasons.some(function (x) { return x.indexOf('overload') !== -1; }), r.reasons.join(' | '));
});

test('a leg that passes a junction carries a joint and its splices', function () {
  // Main street west-east with a side street at the midway junction: A and B are both on the main
  // street, and the only route passes through a degree-3 node, which is where a closure goes.
  const tee = { edges: [
    { id: 'main', coords: [p(51.5, -0.1020), p(51.5, -0.0960)] },
    { id: 'side', coords: [p(51.5, -0.0990), p(51.5030, -0.0990)] }
  ] };
  const r = link.design({ sites: { a: A, b: B }, network: tee, optics: ER, protection: 'single' }, registry);
  const leg = r.legs[0];
  assert.strictEqual(leg.joints.length, 1, 'one junction on the route');
  assert.strictEqual(leg.splices, 2, 'two fibres spliced at that joint');
  assert.strictEqual(r.bom.closures.count, 1);
  assert.strictEqual(r.bom.closures.model, 'mufa-inline-24');
});

test('a site off the network is refused by name, not snapped from afar', function () {
  const far = { name: 'DC-Nowhere', lat: 51.53, lon: -0.1020 };
  const r = link.design({ sites: { a: far, b: B }, network: grid(), optics: ER }, registry);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons[0].indexOf('DC-Nowhere') !== -1, r.reasons[0]);
  assert.ok(r.reasons[0].indexOf('not on the network') !== -1, r.reasons[0]);
  assert.strictEqual(r.legs.length, 0);
});

test('without a graph the link is a straight line, and says so instead of faking protection', function () {
  const r = link.design({ sites: { a: A, b: B }, optics: ER }, registry);
  assert.strictEqual(r.routeMethod, 'straight-line x1.2');
  assert.strictEqual(r.legs.length, 1);
  // 415.3 m x 1.2 = 498.4 m, and the route is two points, because there is no street to follow.
  close(r.legs[0].routedM, 498.4, 1, 'straight-line length');
  assert.strictEqual(r.legs[0].route.length, 2);
  assert.strictEqual(r.diversity.achieved, false);
  assert.strictEqual(r.diversity.sharedM, null, 'one leg has nothing to compare against');
  assert.ok(r.diversity.sentence.indexOf('no protected pair') !== -1, r.diversity.sentence);
  assert.strictEqual(r.runs[0].method, 'straight-line x1.2');
  assert.ok(r.notes.some(function (n) { return n.indexOf('No duct/street network supplied') !== -1; }), r.notes.join(' | '));
});

test('two fibres over a short run are drop cable; over 300 m they are not', function () {
  const shortNet = { edges: [{ id: 'cross', coords: [p(51.5, -0.1000), p(51.5, -0.0970)] }] };
  const short = link.design({
    sites: { a: { name: 'A', lat: 51.5, lon: -0.1000 }, b: { name: 'B', lat: 51.5, lon: -0.0970 } },
    network: shortNet, optics: ER, protection: 'single'
  }, registry);
  // 0.003 deg of longitude at 51.5 = 207.7 m: a two-fibre drop.
  assert.strictEqual(short.legs[0].cable, 'g657a2-drop-2');
  assert.strictEqual(short.legs[0].fiberCount, 2);
  // The same two fibres over the 526 m south leg of the grid are a building-to-building cable run.
  assert.strictEqual(gridLink().legs[0].cable, 'g652d-loose-12');
});

test('a link ladder is a list of catalogue cable models, refused rather than defaulted', function () {
  // The ladder is what every span is bought from, and `link.options` ran every other BOM knob through
  // design-fields and left this one as `Array.isArray(o.ladder) && o.ladder.length ? o.ladder :
  // DEFAULT_LADDER`. A bare model name was read as the default ladder - the 526 m leg below came out
  // on g652d-loose-12, not the g652d-loose-48 the caller named - and a ladder naming a cable the
  // catalogue does not have was dropped without a word whenever the leg was short enough for drop
  // cable (207.7 m here). Auto-design has refused both shapes since #157, and a circuit buys cable too.
  const bare = throws(function () { gridLink({ ladder: 'g652d-loose-48' }); }, 'ladder',
    'a ladder sent as one model name');
  assert.ok(bare.message.indexOf('list') !== -1, bare.message);

  const shortNet = { edges: [{ id: 'cross', coords: [p(51.5, -0.1000), p(51.5, -0.0970)] }] };
  throws(function () {
    link.design({
      sites: { a: { name: 'A', lat: 51.5, lon: -0.1000 }, b: { name: 'B', lat: 51.5, lon: -0.0970 } },
      network: shortNet, optics: ER, protection: 'single', ladder: ['g652d-nope']
    }, registry);
  }, 'g652d-nope', 'a ladder naming a cable the catalogue does not have');

  // The same ladder as a list is read: 526 m is a cable run, not a drop.
  const r = gridLink({ ladder: ['g652d-loose-48'] });
  assert.strictEqual(r.legs[0].cable, 'g652d-loose-48');
  assert.strictEqual(r.bom.cable[0].model, 'g652d-loose-48');
  // An empty ladder is the documented way to ask for the default, and it still answers.
  assert.strictEqual(gridLink({ ladder: [] }).legs[0].cable, 'g652d-loose-12');
});

test('a link with one end missing is a caller error, not a design', function () {
  throws(function () { link.design({ sites: { a: A }, optics: ER }, registry); }, 'sites.b');
  throws(function () { link.design({ sites: { a: A, b: { name: 'B' } }, optics: ER }, registry); }, 'must be numbers');
  throws(function () { link.design({ sites: { a: A, b: A }, optics: ER }, registry); }, 'two different sites');
  throws(function () { link.design({ sites: { a: A, b: B }, optics: ER, protection: 'maybe' }, registry); }, 'protection must be');
  throws(function () { link.design({ sites: { a: A, b: B }, optics: { a: 'sfp-1g-lx-10km', b: 'sfp-plus-10g-lr-10km' } }, registry); }, 'different rates');
});

test('a cable that cannot carry the fibres asked for is refused, not bought short', function () {
  // A 24-fibre link on a 2-fibre drop cable used to come back `verdict: 'ok'` with one 2-fibre cable in
  // the BOM: the leg reported `fiberCount: 2` next to `fibres: 24` and nothing objected. That is the
  // failure `network.strandLedger` exists to catch in a plant - a cable somebody orders and cannot
  // splice - and a link is the one place a cable may be named by hand, so it is the one place the
  // ladder cannot guarantee the fit.
  const err = throws(function () {
    link.design({ sites: { a: A, b: B }, optics: ER, fibres: 24, cable: 'g657a2-drop-2' }, registry);
  }, 'carries 2 fibres but this link asks for 24');
  // The refusal names cables that do fit, so the caller knows what to choose instead.
  assert.ok(String(err.message).indexOf('g652d-loose-24') !== -1, err.message);

  // The ladder falls back to its largest cable when nothing in it carries the count, which is right
  // for an auto-design tree (it bundles) and wrong for a link: 200 fibres on a 144-fibre ladder is a
  // refusal, and the catalogue's 288-fibre ribbon is named as the way out.
  const over = throws(function () {
    link.design({ sites: { a: A, b: B }, optics: ER, fibres: 200 }, registry);
  }, 'carries 144 fibres but this link asks for 200');
  assert.ok(String(over.message).indexOf('g652d-ribbon-288') !== -1, over.message);

  // 400 fibres on the default 144-fibre ladder is still a refusal, but it now names a cable that
  // carries the count: this assertion used to be the "nothing in the catalogue is big enough" case,
  // when the top rung was the 288-fibre ribbon. g652d-ribbon-432 is that answer now (432 is the
  // highest count a closure here can joint - the FOSC 600-D holds 504 splices), and naming a cable
  // by hand designs the link.
  const over400 = throws(function () {
    link.design({ sites: { a: A, b: B }, optics: ER, fibres: 400 }, registry);
  }, 'carries 144 fibres but this link asks for 400');
  assert.ok(String(over400.message).indexOf('g652d-ribbon-432') !== -1, over400.message);
  const big = link.design({ sites: { a: A, b: B }, optics: ER, fibres: 400, cable: 'g652d-ribbon-432' }, registry);
  assert.strictEqual(big.ok, true, String(big.reasons));
  assert.strictEqual(big.legs[0].fiberCount, 432, '400 fibres on the 432-fibre ribbon');

  // Nothing in the catalogue is big enough: say so instead of inventing a suggestion.
  throws(function () {
    link.design({ sites: { a: A, b: B }, optics: ER, fibres: 500 }, registry);
  }, 'no cable in the catalogue carries 500 fibres');

  // Fewer strands than the cable carries is normal - a 24-fibre cable used for 24 fibres passes.
  const fits = link.design({ sites: { a: A, b: B }, optics: ER, fibres: 24, cable: 'g652d-loose-24' }, registry);
  assert.strictEqual(fits.ok, true, fits.reasons.join(' | '));
  assert.strictEqual(fits.legs[0].fiberCount, 24);
  assert.strictEqual(fits.bom.cable.length, 1);
  assert.strictEqual(fits.bom.cable[0].model, 'g652d-loose-24');
});

test('a joint costs the light one splice, however many strands the cable carries', function () {
  // Main street west-east with a side street leaving the midway point: the route passes one degree-3
  // node, so the leg carries one joint. A joint splices every strand the cable carries - that is the
  // crew's count - but the light on any one strand crosses the joint once (SPEC §3). Handing the
  // crew's count to the budget charged a 24-fibre leg 24 x 0.10 dB = 2.40 dB of splice loss at a
  // single joint, against 0.20 dB for the same route on 2 fibres: 2.2 dB that came from the cable's
  // fibre count and had nothing to do with the light. Same cable, same route, so the fibre term is
  // identical by construction and the splice line is the whole difference.
  const tee = { edges: [
    { id: 'main', coords: [p(51.5, -0.1020), p(51.5, -0.0960)] },
    { id: 'side', coords: [p(51.5, -0.0990), p(51.5030, -0.0990)] }
  ] };
  const two = link.design({ sites: { a: A, b: B }, network: tee, optics: ER, protection: 'single',
    fibres: 2, cable: 'g652d-loose-24' }, registry);
  const many = link.design({ sites: { a: A, b: B }, network: tee, optics: ER, protection: 'single',
    fibres: 24, cable: 'g652d-loose-24' }, registry);
  [two, many].forEach(function (r) {
    assert.strictEqual(r.legs[0].joints.length, 1, 'one junction on the route');
    assert.strictEqual(r.legs[0].spliceEvents, 1, 'one splice event on the path');
    const lines = r.legs[0].budget.breakdown.filter(function (b) { return b.kind === 'splice'; });
    assert.strictEqual(lines.length, 1, 'one splice line in the budget');
    close(lines[0].db, 0.1, 0.001, 'one fusion splice at 0.10 dB');
  });
  assert.strictEqual(many.legs[0].budget.odnLossDb, two.legs[0].budget.odnLossDb,
    'the same route and cable cost the light the same, whatever the strand count');
  assert.strictEqual(many.legs[0].budget.headroomDb, two.legs[0].budget.headroomDb);
  // The crew's count does scale with the cable: 2 splices on 2 fibres, 24 on 24.
  assert.strictEqual(two.legs[0].splices, 2, '2 fibres at one joint');
  assert.strictEqual(many.legs[0].splices, 24, '24 fibres at one joint');
  assert.strictEqual(two.bom.splices, 2);
  assert.strictEqual(many.bom.splices, 24);
});

test('an explicit splice count is splice events on the leg, and the crew count follows splicesPerJoint', function () {
  // 3 events x 0.10 dB = 0.30 dB of splice loss; the crew performs 3 x 2 fibres = 6 splices.
  const r = link.design({ sites: { a: A, b: B }, optics: ER, protection: 'single', splices: 3 }, registry);
  const lines = r.legs[0].budget.breakdown.filter(function (b) { return b.kind === 'splice'; });
  close(lines[0].db, 0.3, 0.001, '3 splice events at 0.10 dB');
  assert.strictEqual(r.legs[0].spliceEvents, 3);
  assert.strictEqual(r.legs[0].splices, 6, '3 events on 2 fibres');
  assert.strictEqual(r.bom.splices, 6);
  // A joint worked once per event (a mass-fusion pass, or a single-strand circuit) says so directly.
  const once = link.design({ sites: { a: A, b: B }, optics: ER, protection: 'single', splices: 3, splicesPerJoint: 1 }, registry);
  assert.strictEqual(once.legs[0].spliceEvents, 3);
  assert.strictEqual(once.legs[0].splices, 3);
  assert.strictEqual(once.bom.splices, 3);
});

test('a leased B-leg on a circuit with no B-leg is named, not charged', function () {
  // No network: one straight-line leg, so a segment assigned to the B-leg belongs to a leg that does
  // not exist. It is not on the path the light takes and nobody buys it, yet it used to be counted in
  // the BOM anyway: thirdParty read 400 m and 1600 while the one leg carried 100 m and 400 of that.
  // The lease is still LISTED - dropping it silently is the other way to be wrong about money.
  const r = link.design({ sites: { a: A, b: B }, optics: ER, thirdParty: [
    { provider: 'CityFibre', lengthM: 300, lossDb: 0.6, cost: 1200, leg: 'b' },
    { provider: 'Zayo', lengthM: 100, lossDb: 0.2, cost: 400, leg: 'a' }
  ] }, registry);
  assert.strictEqual(r.legs.length, 1);
  close(r.legs[0].leasedM, 100, 0.001, 'the one leg runs on the A-leg lease');
  // 100 m of lease on the only leg; the 300 m B-leg lease is on no leg at all.
  close(r.bom.thirdParty.totalM, 100, 0.001, 'the leased total is the lease the circuit runs on');
  close(r.bom.thirdParty.lossDb, 0.2, 0.001, 'only a charged lease costs the light loss');
  assert.strictEqual(r.bom.thirdParty.cost, 400);
  close(r.bom.leasedTotalM, 100, 0.001);
  const cityFibre = r.thirdParty.segments.filter(function (s) { return s.provider === 'CityFibre'; })[0];
  assert.strictEqual(cityFibre.attached, false, 'the B-leg lease is not on this circuit');
  assert.strictEqual(r.thirdParty.unattached.length, 1, 'one declared segment rides no leg');
  close(r.thirdParty.unattachedM, 300, 0.001);
  assert.strictEqual(r.thirdParty.unattachedCost, 1200);
  assert.ok(r.warnings.some(function (w) {
    return w.indexOf('CityFibre') !== -1 && w.indexOf('B-leg') !== -1 && w.indexOf('not part of the circuit') !== -1;
  }), r.warnings.join(' | '));
});

test('protection single drops the B-leg lease from the cost, and still names it', function () {
  const r = link.design({ sites: { a: A, b: B }, network: grid(), optics: ER, protection: 'single',
    thirdParty: [{ provider: 'CityFibre', lengthM: 300, lossDb: 0.6, cost: 1200, leg: 'b' }] }, registry);
  assert.strictEqual(r.legs.length, 1);
  assert.strictEqual(r.bom.thirdParty.totalM, 0, 'no leg carries the lease');
  assert.strictEqual(r.bom.thirdParty.cost, 0);
  assert.strictEqual(r.thirdParty.segments[0].attached, false);
  assert.strictEqual(r.thirdParty.unattachedCost, 1200, 'the intent is still reported, outside the cost');
  assert.ok(r.warnings.some(function (w) { return w.indexOf('protection is single') === 0; }), r.warnings.join(' | '));
});

test('a refused link still lists its declared leases, unattached and uncosted', function () {
  const far = { name: 'DC-Nowhere', lat: 51.53, lon: -0.1020 };
  const r = link.design({ sites: { a: far, b: B }, network: grid(), optics: ER,
    thirdParty: [{ provider: 'CityFibre', lengthM: 300, lossDb: 0.6, cost: 1200, leg: 'b' }] }, registry);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.bom, null);
  assert.strictEqual(r.thirdParty.segments.length, 1, 'the declared lease is not dropped from the report');
  assert.strictEqual(r.thirdParty.segments[0].attached, false);
  assert.strictEqual(r.thirdParty.totalM, 0);
  assert.strictEqual(r.thirdParty.unattachedCost, 1200);
});

test('a leg route reaches both sites, so the drawing covers the cable the BOM buys', function () {
  // One duct running west-east at 51.5000. Both sites sit 0.0004 deg north of it - 44.5 m - so the snap
  // puts them on the duct and that gap is the drop. `ownM` (and the BOM built on it) already pays for
  // the drop; the route handed to a map stopped at the manhole and drew two legs ending in mid-duct,
  // 88.96 m shorter than the cable the same result quoted. A route is the thing somebody pulls.
  const corridor = { edges: [{ id: 'duct', coords: [p(51.5000, -0.1020), p(51.5000, -0.0960)] }] };
  const A2 = { name: 'DC-West', lat: 51.5004, lon: -0.1018 };
  const B2 = { name: 'DC-East', lat: 51.5004, lon: -0.0962 };
  const r = link.design({ sites: { a: A2, b: B2 }, network: corridor, optics: ER }, registry);
  const leg = r.legs[0];
  // 0.0004 deg of latitude is 44.5 m, so both drops together are 88.96 m on a 387.64 m duct run.
  close(leg.spurM, 88.96, 0.2, 'the two site drops');
  close(leg.ownM, 476.6, 0.5, 'routed 387.64 + drops 88.96');
  assert.strictEqual(leg.route[0].lat, A2.lat, 'the route starts at site A');
  assert.strictEqual(leg.route[0].lon, A2.lon);
  const last = leg.route[leg.route.length - 1];
  assert.strictEqual(last.lat, B2.lat, 'the route ends at site B');
  assert.strictEqual(last.lon, B2.lon);
  // The geometry now measures what the cable line buys: 387.64 m of duct + 88.96 m of drop.
  close(engine.geo.pathLengthM(leg.route), leg.ownM, 0.5, 'route metres against ownM');
  // Every surface that draws a leg gets the same geometry.
  assert.strictEqual(r.paths[0].route[0].lat, A2.lat, 'paths[].route starts at the site');
  const run = r.runs.filter(function (x) { return x.id === 'link-a'; })[0];
  assert.strictEqual(run.route[run.route.length - 1].lat, B2.lat, 'runs[].route ends at the site');

  // A site already on the duct must not be pinned twice: gridLink's A and B sit on the graph, so the
  // route is the duct's own geometry and the first two points are different places.
  const on = gridLink();
  assert.strictEqual(on.legs[0].spurM, 0, 'no drop to draw');
  const route = on.legs[0].route;
  assert.ok(route[0].lat !== route[1].lat || route[0].lon !== route[1].lon,
    'the first duct point is not repeated as a site drop');
});

test('a splices-per-joint count is whole, refused rather than rounded into the BOM', function () {
  // The crew's count is `spliceEvents x splicesPerJoint`, and it is what the BOM bills and what the
  // splice reserve (30 m per splice) is charged on. Three joints at 2.5 splices is 7.5, and `round`
  // answered 8 - a splice nobody makes, on a document that goes on a purchase order. The other three
  // counts read by `link.options` (`fibres`, `connectors`, `splices`) are refused when they are not
  // whole numbers; this one was multiplied through and rounded instead.
  throws(function () { gridLink({ splices: 3, splicesPerJoint: 2.5 }); }, 'splicesPerJoint',
    'a fractional splices-per-joint');
  throws(function () { gridLink({ splicesPerJoint: 1.2 }); }, 'splicesPerJoint', '1.2 per joint');
  // A whole count still answers, and it multiplies the joint count exactly: 3 joints x 2 = 6 per leg.
  const r = gridLink({ splices: 3, splicesPerJoint: 2 });
  assert.strictEqual(r.legs[0].splices, 6, '3 joints x 2 splices = 6 on the leg');
  assert.strictEqual(r.bom.splices, 12, 'both grid legs: 6 + 6');
});

// `link.options` validated the values of the knobs it reads but never a key list, so the one entry
// point that answers with a circuit's purchase order read no list at all: a near miss was not a
// setting the link rejected, it was not a key - the default ran and the answer looked complete.
// Measured on the grid fixture above before this guard: `{ overlengthPct: 10 }` answers `designM`
// 1280.64 (1164.22 m of leg x 1.10), `{ overlenghtPct: 10 }` and `{ overlengthpct: 10 }` answer
// 1199.15 - the 3% default, 81.49 m of cable short - and `{ marignDb: 10 }` budgets both legs at the
// 3 dB reserve where a 10 dB reserve turns their 10.39 / 10.37 dB of headroom marginal.
test('a near-miss link option is refused by name, not silently defaulted', function () {
  // A case slip: the caller asked to buy 10% overlength, the BOM would quote the 3% default.
  throws(function () { gridLink({ overlengthpct: 10 }); }, 'overlengthPct', 'a case slip');
  // A singular where the field is plural: the two patch panels, not the four asked for.
  throws(function () { gridLink({ connector: 4 }); }, 'connectors', 'a singular for connectors');
  // A prefix of a field it reads: `margin` is not `marginDb`, and the reserve moves every verdict.
  throws(function () { gridLink({ margin: 10 }); }, 'marginDb', 'a prefix of marginDb');
  // One letter deleted: the leased segments, and the loss they state, would vanish from both the
  // path and the cost.
  throws(function () { gridLink({ thirParty: [] }); }, 'thirdParty', 'a deletion in thirdParty');
  // A swapped adjacent pair is one keystroke. `marignDb` budgeted both legs at the 3 dB reserve where
  // 10 dB turns their headroom marginal, and `overlenghtPct` bought the 3% default: 81.49 m short.
  throws(function () { gridLink({ marignDb: 10 }); }, 'did you mean "marginDb"', 'a swapped pair in marginDb');
  throws(function () { gridLink({ overlenghtPct: 10 }); }, 'did you mean "overlengthPct"', 'a swapped pair in overlengthPct');
  throws(function () { gridLink({ thridParty: [] }); }, 'did you mean "thirdParty"', 'a swapped pair in thirdParty');
  // The refusal says which surface and names the field, so a caller can fix it without reading code.
  const err = throws(function () { gridLink({ routefactr: 1.4 }); }, 'routeFactor', 'a route factor typo');
  assert.ok(/link design does not read the option/.test(err.message), err.message);
  // It is a near miss guard, not an unknown-key guard: a caller's own bookkeeping still passes and
  // the circuit it describes is unchanged.
  const named = gridLink({ name: 'DC-to-DC primary', notes: 'MO-4471' });
  assert.strictEqual(named.ok, true);
  close(named.bom.cable[0].designM, 1199.15, 0.05, 'bookkeeping keys change no metres');
});
