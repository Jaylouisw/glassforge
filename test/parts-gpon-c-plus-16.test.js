'use strict';
// The GPON OLT ladder was class B+ 8 ports, C+ 8 ports, C++ 16 ports. A plant is a tree with exactly
// one root (SPEC §1), so a C+ site that needs 9 to 16 PON ports had no row to stand on:
// gpon-c-plus-8 refused the design by name - "needs 12 PON port(s) but gpon-c-plus-8 has 8" - and the
// only 16-port row was gpon-c-plus-plus-16, whose class buys 35 dB where a C+ line card buys 32 and
// whose launch tops at +10 dBm against +7. Three dB of ODN loss the purchased card does not have, on
// the one card shape a dense C+ chassis ships. gpon-c-plus-16 is that row: the same class as the
// 8-port card, sixteen ports.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

// Everything about a C+ card except how many ports it carries. A port-count variant that moved any
// of these would be a different part wearing the same class name.
const CLASS_FIELDS = ['pon', 'class', 'txPowerDbmMin', 'txPowerDbmMax', 'rxSensitivityDbm',
  'rxOverloadDbm', 'budgetDb', 'maxSplitRatio'];

test('gpon-c-plus-16 is the C+ card at sixteen ports, with no optical figure moved', function () {
  const row = registry.get('olt', 'gpon-c-plus-16');
  const eight = registry.get('olt', 'gpon-c-plus-8');
  for (const field of CLASS_FIELDS) {
    assert.deepStrictEqual(row[field], eight[field], field + ' must not drift from the 8-port C+ card');
  }
  assert.strictEqual(row.kind, 'olt');
  assert.strictEqual(row.model, 'gpon-c-plus-16', 'model equals the filename');
  assert.strictEqual(row.ports, 16);
  assert.ok(/^https:\/\//.test(row.sourceUrl || ''), 'an OLT row that sets a class budget names its source');
  assert.ok(/G\.984\.2/.test(row.notes), 'notes name the recommendation the class figures come from');
  assert.ok(/replace/i.test(row.notes),
    'the caveat that a class figure is not the bought card travels with the row');
});

test('it is the smallest C+ card that serves a twelve-site plant', function () {
  const fits = registry.all('olt').filter(function (o) {
    return o.class === 'C+' && o.ports >= 12;
  }).sort(function (a, b) {
    return a.ports - b.ports || (a.model < b.model ? -1 : 1);
  });
  // Before this row the answer was gpon-c-plus-plus-16: sixteen ports, but 35 dB of class.
  assert.ok(fits.length >= 1, 'no C+ card holds twelve PON ports');
  assert.strictEqual(fits[0].model, 'gpon-c-plus-16', 'smallest fitting C+ card: ' + fits[0].model);
  assert.strictEqual(fits[0].ports, 16);
});

/** 140 addresses on a 17 x 9 grid, 1:32 splitters -> twelve splitter sites: 8 ports too few. */
function estate(n) {
  const demand = [];
  for (let i = 0; i < n; i++) {
    demand.push({ id: 'h' + i, lat: 51.5 + (i % 17) * 0.0006, lon: -0.1 + Math.floor(i / 17) * 0.0009 });
  }
  return demand;
}

const HEAD_END = { id: 'he', lat: 51.5, lon: -0.1005 };

function designOn(oltModel) {
  return engine.design.synthesise(estate(140), {
    headEnd: HEAD_END,
    technology: 'pon',
    pon: { ratios: [32], olt: oltModel, ont: 'gpon-ont-4ge' }
  }, registry);
}

test('a twelve-site C+ estate is refused by the 8-port card by name and designed on the 16-port one', function () {
  const eight = designOn('gpon-c-plus-8');
  assert.strictEqual(eight.best, null, '8 ports cannot serve 12 splitter sites');
  assert.ok(eight.notes.join(' ').indexOf('needs 12 PON port(s) but gpon-c-plus-8 has 8') !== -1,
    'the refusal names the port shortage: ' + eight.notes.join('; '));

  const sixteen = designOn('gpon-c-plus-16');
  const best = sixteen.best;
  assert.ok(best, 'the 16-port card must design the estate the 8-port card refused: ' + sixteen.notes.join('; '));
  const candidate = sixteen.candidates[0];
  assert.strictEqual(candidate.feasible, true);
  assert.strictEqual(candidate.settings.ponPortsNeeded, 12);
  assert.strictEqual(candidate.metrics.splitters, 12);
  assert.strictEqual(candidate.metrics.onts, 140);
  const portReasons = candidate.reasons.filter(function (r) { return /PON port/.test(r); });
  assert.strictEqual(portReasons.length, 0, 'no port shortage on a 16-port card');
});

test('the extra ports do not buy the C++ class: the same ODN reads 32 dB, not 35', function () {
  const base = {
    ont: { model: 'gpon-ont-4ge' },
    wavelength: '1490',
    spans: [{ cable: 'g652d-loose-24', lengthM: 9000 }],
    splitters: [{ model: 'plc-1x32-sca' }],
    splices: 2,
    connectors: 2
  };
  const cplus = engine.budget.opticalBudget(Object.assign({}, base, { olt: { model: 'gpon-c-plus-16' } }), registry);
  // 9.0 km x 0.22 = 1.98; 2 splices x 0.10 = 0.20; 2 connector pairs x 0.30 = 0.60; plc-1x32 = 17.10
  // -> ODN 19.88 dB; 32 - 19.88 = 12.12 dB of class headroom.
  close(cplus.odnLossDb, 19.88, 0.001, 'ODN loss (1.98 + 0.20 + 0.60 + 17.10)');
  close(cplus.classHeadroomDb, 12.12, 0.01, 'class headroom against the C+ 32 dB budget');
  assert.strictEqual(cplus.verdict, 'ok');

  const cplusplus = engine.budget.opticalBudget(Object.assign({}, base, { olt: { model: 'gpon-c-plus-plus-16' } }), registry);
  close(cplusplus.classHeadroomDb - cplus.classHeadroomDb, 3, 0.001,
    '35 dB - 32 dB: the 3 dB a C++ card buys and a C+ card does not');
});

done();
