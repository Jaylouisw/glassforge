'use strict';
// An active link is budgeted between two optics, not against a PON class.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

/**
 * A registry whose two optics differ, which the shipped catalogue cannot offer.
 *
 * A point-to-point budget refuses a pair that differs in rate or wavelength, so the only legal
 * "two different optics" fixture is a pair that agrees on both and differs in its datasheet. Cloning
 * the catalogue's LR entry keeps every validated field present; B is a 40 km part with a hotter
 * launch and a more sensitive receiver, so which end the engine reads is visible in the result.
 */
const twoOptics = (function () {
  const specs = engine.parts.loadSpecs().specs;
  const base = specs.filter(function (s) { return s.kind === 'transceiver' && s.model === 'sfp-plus-10g-lr-10km'; })[0];
  const a = Object.assign({}, base, { model: 'test-optic-a-agg', label: 'Test optic A: aggregation end, 10 km' });
  const b = Object.assign({}, base, {
    model: 'test-optic-b-cpe',
    label: 'Test optic B: customer end, 40 km',
    reachM: 40000,
    txPowerDbmMin: -3,
    txPowerDbmMax: 2,
    rxSensitivityDbm: -18,
    rxOverloadDbm: -1
  });
  delete a._search;
  delete b._search;
  return new engine.parts.Registry(specs.concat([a, b]));
}());

function link(overrides) {
  return Object.assign({
    headEnd: { model: 'sfp-plus-10g-lr-10km' },
    cpe: { model: 'sfp-plus-10g-lr-10km' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }],
    splices: 0,
    connectors: 2
  }, overrides || {});
}

test('10GBASE-LR over 1 km closes inside its own budget', function () {
  const r = budget.pointToPoint(link(), registry);
  // 1.0 km x 0.35 = 0.35 dB, 2 connectors x 0.3 = 0.60 -> ODN 0.95 dB
  close(r.odnLossDb, 0.95, 0.001, 'ODN loss');
  // Rx = -8.2 - 0.95 = -9.15 dBm against -14.4 dBm sensitivity -> 5.25 dB of headroom
  close(r.rxPowerDbm, -9.15, 0.001, 'receive power');
  close(r.headroomDb, 5.25, 0.001, 'headroom');
  // The budget is the optic pair's own: launch -8.2, sensitivity -14.4
  close(r.budgetDb, 6.2, 0.001, 'link budget');
  assert.strictEqual(r.technology, 'p2p');
  assert.strictEqual(r.verdict, 'ok');
});

test('the same cable on 4 km is marginal, and on 12 km it fails on margin and reach', function () {
  const four = budget.pointToPoint(link({ spans: [{ cable: 'g652d-loose-12', lengthM: 4000 }], splices: 2 }), registry);
  close(four.headroomDb, 4.0, 0.001, '4 km headroom');
  assert.strictEqual(four.verdict, 'marginal');

  const twelve = budget.pointToPoint(link({ spans: [{ cable: 'g652d-loose-12', lengthM: 12000 }], splices: 2 }), registry);
  assert.strictEqual(twelve.verdict, 'fail');
  assert.ok(twelve.reasons.some(function (r) { return r.indexOf('design margin') !== -1; }), twelve.reasons.join(' | '));
  assert.ok(twelve.reasons.some(function (r) { return r.indexOf('optic reaches 10000 m') !== -1; }), twelve.reasons.join(' | '));
});

test('a 1 Gb/s optic has more budget than a 10 Gb/s one, and the engine says so', function () {
  const g1 = budget.pointToPoint(link({ headEnd: { model: 'sfp-1g-lx-10km' }, cpe: { model: 'sfp-1g-lx-10km' } }), registry);
  const g10 = budget.pointToPoint(link(), registry);
  assert.ok(g1.budgetDb > g10.budgetDb);
  close(g1.budgetDb, 10.5, 0.001, '1G-LX budget (launch -9.5, sensitivity -20)');
  close(g10.budgetDb, 6.2, 0.001, '10G-LR budget');
  assert.strictEqual(g1.speedMbps, 1000);
});

test('optics that cannot hear each other are refused, not averaged', function () {
  throws(function () {
    budget.pointToPoint(link({ cpe: { model: 'sfp-1g-lx-10km' } }), registry);
  }, 'different rates');
  throws(function () {
    budget.pointToPoint(link({ cpe: { model: 'sfp-plus-10g-er-40km' } }), registry);
  }, 'different wavelengths');
  throws(function () {
    budget.pointToPoint(link({ wavelength: '1550' }), registry);
  }, 'cannot be budgeted at');
});

test('too much power is a failure on an active link too', function () {
  const r = budget.pointToPoint({
    headEnd: { model: 'sfp-1g-zx-80km' },
    cpe: { model: 'sfp-1g-zx-80km' },
    spans: [{ cable: 'g657a2-drop-1', lengthM: 5 }],
    connectors: 2
  }, registry);
  // Tx 0 dBm, 5 m of fibre and two connectors -> about -0.6 dBm at a receiver whose overload is -3
  assert.ok(r.reasons.some(function (x) { return x.indexOf('overload') !== -1; }), r.reasons.join(' | '));
  assert.strictEqual(r.verdict, 'fail');
});

test('upstream uses the customer optic as the transmitter', function () {
  // Two *different* optics on the same rate and wavelength: `a` at the aggregation end, `b` at the
  // customer end. With one model at both ends the sensitivity is the same figure whichever end the
  // engine read, so the direction was never actually observed. The shipped catalogue has no such
  // pair, hence a test registry cloned from one entry with B's datasheet changed.
  const design = { headEnd: { model: 'test-optic-a-agg' }, cpe: { model: 'test-optic-b-cpe' } };
  const down = budget.pointToPoint(link(design), twoOptics);
  const up = budget.pointToPoint(link(Object.assign({ direction: 'up' }, design)), twoOptics);

  // Downstream: A launches at -8.2 dBm and B receives against -18 dBm. 0.95 dB of ODN -> -9.15 dBm.
  assert.strictEqual(down.direction, 'down');
  close(down.txDbm, -8.2, 0.001, 'downstream launch is the head-end optic');
  assert.strictEqual(down.sensitivityDbm, -18, 'downstream receives into the customer optic');
  close(down.rxPowerDbm, -9.15, 0.001, 'downstream receive power');
  close(down.headroomDb, 8.85, 0.001, 'downstream headroom against -18 dBm');

  // Upstream: B launches at -3 dBm and A receives against -14.4 dBm -> -3.95 dBm, 10.45 dB of
  // headroom. An rxSpec that ignored direction would report -18 dBm and 3.1 dB more headroom here.
  assert.strictEqual(up.direction, 'up');
  close(up.txDbm, -3, 0.001, 'upstream launch is the customer optic');
  assert.strictEqual(up.sensitivityDbm, -14.4, 'upstream receives into the head-end optic');
  close(up.rxPowerDbm, -3.95, 0.001, 'upstream receive power');
  close(up.headroomDb, 10.45, 0.001, 'upstream headroom against -14.4 dBm');

  // The pair's own budget flips with the direction too: upstream it is B's launch into A's receiver,
  // -3 - (-14.4) = 11.4 dB, not the downstream 9.8 dB. The engine used to read the head-end launch in
  // both directions, so an upstream leg reported the other end's 9.8 dB (and 8.85 dB of class
  // headroom) while its own headroom said 10.45 dB.
  close(down.budgetDb, 9.8, 0.001, 'downstream budget (A launches, B receives)');
  close(up.budgetDb, 11.4, 0.001, 'upstream budget (B launches, A receives)');
  // With no design allowance, a point-to-point link's class headroom *is* its loss headroom: both are
  // budget - ODN. Two different figures for one question is the symptom this test exists for.
  close(down.classHeadroomDb, down.headroomDb, 0.001, 'downstream class headroom equals headroom');
  close(up.classHeadroomDb, up.headroomDb, 0.001, 'upstream class headroom equals headroom');

  // Reach is the shorter of the two datasheets, in both directions: A reaches 10 km, B reaches 40 km.
  assert.strictEqual(down.reachM, 10000, 'downstream reach');
  assert.strictEqual(up.reachM, 10000, 'upstream reach');
  assert.ok(up.warnings.length === 0 || up.warnings[0].indexOf('no cable spans') === -1);
});

test('a missing optic is refused by name', function () {
  throws(function () { budget.pointToPoint({ headEnd: {}, cpe: { model: 'x' } }, registry); }, 'headEnd.model');
  throws(function () { budget.pointToPoint({ headEnd: { model: 'nope' }, cpe: { model: 'sfp-1g-lx-10km' } }, registry); }, 'unknown transceiver model');
});

test('the catalogue carries optics for 1G, 10G, 25G and 100G with published figures', function () {
  const optics = registry.all('transceiver');
  assert.ok(optics.length >= 4);
  for (const optic of optics) {
    assert.ok(optic.reachM > 0);
    assert.ok(optic.rxSensitivityDbm < optic.rxOverloadDbm);
    assert.ok(/^https:\/\//.test(optic.sourceUrl));
  }
  const speeds = optics.map(function (o) { return o.speedMbps; });
  // One optic at each rung a site-to-site link is actually bought at. 100G was the gap: a metro
  // DC-to-DC run is 100GBASE-LR4/ER4, and a ladder that stopped at 25G could not describe one.
  assert.ok(speeds.indexOf(1000) !== -1 && speeds.indexOf(10000) !== -1 && speeds.indexOf(25000) !== -1,
    'the catalogue has 1G, 10G and 25G optics');
  assert.ok(speeds.indexOf(100000) !== -1, 'the catalogue has a 100G optic');
});
