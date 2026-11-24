'use strict';
// A PON is one glass and two carriers: the OLT launches downstream at 1490 nm (1550 for an RF
// overlay) and the ONT launches upstream at 1310 nm. `wavelength` used to be read independently of
// `direction`, so the budget would answer an *upstream* verdict computed at a downstream wavelength -
// a figure for a link no PON has, on an answer labelled "Upstream".
//
// This is not a rounding difference. The same 16 km GPON B+ plant through a 1:64 costs, upstream:
//   1310 nm: 16.0 x 0.35 = 5.60 dB of fibre -> ODN 26.90 dB -> headroom 1.60 dB -> `fail`
//   1550 nm: 16.0 x 0.21 = 3.36 dB of fibre -> ODN 24.86 dB -> headroom 3.64 dB -> `marginal`
// (splices 4 x 0.10 = 0.40, connectors 2 x 0.30 = 0.60, 1:64 = 18.06 + 2.44 = 20.50 in both)
// so a wrong label turned a link 1.60 dB short of its 3 dB margin into one that passes, silently.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

function pon(overrides) {
  return Object.assign({
    olt: { model: 'gpon-c-plus-8' },
    ont: { model: 'gpon-ont-4ge' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 3000 }],
    splitters: [{ model: 'plc-1x8-sca' }],
    splices: 4,
    connectors: 2
  }, overrides || {});
}

test('every pair a PON actually has is budgeted', function () {
  // Downstream carrier, and the same link at 1490 nm: 3.0 km x 0.22 = 0.66 dB of fibre.
  const down = budget.opticalBudget(pon({ direction: 'down', wavelength: '1490' }), registry);
  assert.strictEqual(down.direction, 'down');
  assert.strictEqual(down.wavelength, '1490');
  close(down.odnLossDb, 12.16, 0.001, 'downstream ODN at 1490 nm');
  // 1550 nm is the RF overlay carrier, so it is a downstream wavelength too: 3.0 x 0.21 = 0.63.
  const overlay = budget.opticalBudget(pon({ direction: 'down', wavelength: '1550' }), registry);
  assert.strictEqual(overlay.wavelength, '1550');
  close(overlay.odnLossDb, 12.13, 0.001, 'downstream ODN at 1550 nm');
  // Upstream carrier: 3.0 x 0.35 = 1.05 dB of fibre, so ODN 12.55 dB.
  const up = budget.opticalBudget(pon({ direction: 'up', wavelength: '1310' }), registry);
  assert.strictEqual(up.wavelength, '1310');
  close(up.odnLossDb, 12.55, 0.001, 'upstream ODN at 1310 nm');
});

test('upstream at a downstream wavelength is refused, naming the pair and the legal one', function () {
  // The verdict this refusal replaces: ODN 24.86 dB and `marginal` on a link that fails at 1310.
  const err = throws(function () {
    budget.opticalBudget(pon({
      direction: 'up',
      wavelength: '1550',
      olt: { model: 'gpon-b-plus-8' },
      ont: { model: 'gpon-ont-1ge' },
      spans: [{ cable: 'g652d-loose-12', lengthM: 16000 }],
      splitters: [{ model: 'plc-1x64-sca' }]
    }), registry);
  }, 'upstream is budgeted at 1310 nm, not 1550 nm', 'the pair');
  assert.ok(err.message.indexOf('describes a link that does not exist') !== -1,
    'the refusal says why the pair cannot be answered: ' + err.message);
});

test('downstream at the upstream wavelength is refused', function () {
  const err = throws(function () {
    budget.opticalBudget(pon({ direction: 'down', wavelength: '1310' }), registry);
  }, 'downstream is budgeted at 1490 or 1550 nm, not 1310 nm', 'the pair');
  assert.ok(err.message.indexOf('upstream at 1310 nm') !== -1,
    'the refusal names the direction 1310 belongs to: ' + err.message);
});

test('the 16 km B+ link still fails upstream at its own wavelength', function () {
  const up = budget.opticalBudget(pon({
    direction: 'up',
    olt: { model: 'gpon-b-plus-8' },
    ont: { model: 'gpon-ont-1ge' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 16000 }],
    splitters: [{ model: 'plc-1x64-sca' }]
  }), registry);
  // 16.0 x 0.35 = 5.60; splices 4 x 0.10 = 0.40; connectors 2 x 0.30 = 0.60;
  // plc-1x64-sca 18.06 + 2.44 = 20.50  ->  ODN 27.10 dB; the ONT launches +0.5 dBm
  // -> -26.60 dBm at the OLT's -28 dBm receiver, so headroom 1.40 dB against a 3 dB margin: `fail`.
  assert.strictEqual(up.wavelength, '1310', 'the default upstream wavelength');
  close(up.odnLossDb, 27.10, 0.001, 'upstream ODN at 1310 nm');
  close(up.headroomDb, 1.40, 0.001, 'headroom against the OLT receiver');
  assert.strictEqual(up.verdict, 'fail', 'the link is short of its margin upstream, and saying so is the point');
  assert.ok(up.headroomDb < up.marginDb,
    'the failure is the headroom (' + up.headroomDb + ' dB against a ' + up.marginDb + ' dB margin)');
});

test('a wavelength the budget cannot read is refused, not defaulted', function () {
  // `Number('')` is 0 and `'' || default` is the default: an empty form cell used to budget at
  // 1490 nm and echo it, so the caller never learned the field they sent was not read.
  throws(function () {
    budget.opticalBudget(pon({ wavelength: '' }), registry);
  }, 'unknown wavelength ""', 'an empty cell');
  throws(function () {
    budget.opticalBudget(pon({ wavelength: 0 }), registry);
  }, 'unknown wavelength "0"', 'a zero');
  // Absent is absent, and null means "not set" everywhere else in this model.
  assert.strictEqual(budget.opticalBudget(pon({}), registry).wavelength, '1490');
  assert.strictEqual(budget.opticalBudget(pon({ wavelength: null }), registry).wavelength, '1490');
});

done();
