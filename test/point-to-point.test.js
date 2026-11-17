'use strict';
// An active link is budgeted between two optics, not against a PON class.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

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
  const r = budget.pointToPoint(link({ direction: 'up' }), registry);
  assert.strictEqual(r.direction, 'up');
  assert.strictEqual(r.sensitivityDbm, -14.4, 'the head-end optic is the receiver upstream');
  assert.ok(r.warnings.length === 0 || r.warnings[0].indexOf('no cable spans') === -1);
});

test('a missing optic is refused by name', function () {
  throws(function () { budget.pointToPoint({ headEnd: {}, cpe: { model: 'x' } }, registry); }, 'headEnd.model');
  throws(function () { budget.pointToPoint({ headEnd: { model: 'nope' }, cpe: { model: 'sfp-1g-lx-10km' } }, registry); }, 'unknown transceiver model');
});

test('the catalogue carries optics for 1G, 10G and 25G with published figures', function () {
  const optics = registry.all('transceiver');
  assert.ok(optics.length >= 4);
  for (const optic of optics) {
    assert.ok(optic.reachM > 0);
    assert.ok(optic.rxSensitivityDbm < optic.rxOverloadDbm);
    assert.ok(/^https:\/\//.test(optic.sourceUrl));
  }
  const speeds = optics.map(function (o) { return o.speedMbps; });
  assert.ok(speeds.indexOf(1000) !== -1 && speeds.indexOf(10000) !== -1 && speeds.indexOf(25000) !== -1);
});
