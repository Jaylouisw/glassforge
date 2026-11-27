'use strict';
// The GPON OLT ladder is class B+ at eight ports (gpon-b-plus-8), class C+ at eight and class C++ at
// sixteen. A plant is a tree with exactly one root (SPEC §1), so a B+ site that needs
// nine to sixteen PON ports has no row to stand on: gpon-b-plus-8 refuses it by name, and the only
// sixteen-port GPON row is the C++ card at 35 dB of class against B+'s 28 - 7 dB of ODN loss the
// purchased B+ card never bought. A sixteen-port C+ card is 32 dB, still 4 dB more. gpon-b-plus-16 is
// that row: the eight-port card's optics, sixteen ports.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

// Everything about a B+ card except how many ports it carries. A port-count variant that moved any of
// these would be a different part wearing the same class name.
const CLASS_FIELDS = ['pon', 'class', 'txPowerDbmMin', 'txPowerDbmMax', 'rxSensitivityDbm',
  'rxOverloadDbm', 'budgetDb', 'maxSplitRatio'];

test('gpon-b-plus-16 is the B+ card at sixteen ports, with no optical figure moved', function () {
  const row = registry.get('olt', 'gpon-b-plus-16');
  const eight = registry.get('olt', 'gpon-b-plus-8');
  for (const field of CLASS_FIELDS) {
    assert.deepStrictEqual(row[field], eight[field], field + ' must not drift from the 8-port B+ card');
  }
  assert.strictEqual(row.kind, 'olt');
  assert.strictEqual(row.model, 'gpon-b-plus-16', 'model equals the filename');
  assert.strictEqual(row.ports, 16);
  assert.ok(/^https:\/\//.test(row.sourceUrl || ''), 'an OLT row that sets a class budget names its source');
  assert.ok(/G\.984\.2/.test(row.notes), 'notes name the recommendation the class figures come from');
  assert.ok(/replace/i.test(row.notes),
    'the caveat that a class figure is not the bought card travels with the row');
});

test('it is the smallest B+ card that serves a twelve-site plant', function () {
  const fits = registry.all('olt').filter(function (o) {
    return o.class === 'B+' && o.ports >= 12;
  }).sort(function (a, b) {
    return a.ports - b.ports || (a.model < b.model ? -1 : 1);
  });
  // Before this row there was no B+ card with twelve ports at all: the 8-port row stopped the design
  // and the next sixteen-port row in the catalogue was a 32 dB C+ or a 35 dB C++ card.
  assert.ok(fits.length >= 1, 'no B+ card holds twelve PON ports');
  assert.strictEqual(fits[0].model, 'gpon-b-plus-16', 'smallest fitting B+ card: ' + fits[0].model);
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
    pon: { ratios: [32], olt: oltModel, ont: 'gpon-ont-b-plus-4ge' }
  }, registry);
}

test('a twelve-site B+ estate is refused by the 8-port card by name and designed on the 16-port one', function () {
  const eight = designOn('gpon-b-plus-8');
  assert.strictEqual(eight.best, null, '8 ports cannot serve 12 splitter sites');
  assert.ok(eight.notes.join(' ').indexOf('needs 12 PON port(s) but gpon-b-plus-8 has 8') !== -1,
    'the refusal names the port shortage: ' + eight.notes.join('; '));

  const sixteen = designOn('gpon-b-plus-16');
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

test('the extra ports do not buy another class: the same ODN reads 28 dB, not 32 or 35', function () {
  const base = {
    ont: { model: 'gpon-ont-b-plus-4ge' },
    wavelength: '1490',
    spans: [{ cable: 'g652d-loose-24', lengthM: 9000 }],
    splitters: [{ model: 'plc-1x32-sca' }],
    splices: 2,
    connectors: 2
  };
  const bplus = engine.budget.opticalBudget(Object.assign({}, base, { olt: { model: 'gpon-b-plus-16' } }), registry);
  // 9.0 km x 0.22 = 1.98; 2 splices x 0.10 = 0.20; 2 connector pairs x 0.30 = 0.60; plc-1x32 = 17.10
  // -> ODN 19.88 dB; 28 - 19.88 = 8.12 dB of class headroom.
  close(bplus.odnLossDb, 19.88, 0.001, 'ODN loss (1.98 + 0.20 + 0.60 + 17.10)');
  close(bplus.classHeadroomDb, 8.12, 0.01, 'class headroom against the B+ 28 dB budget');
  assert.strictEqual(bplus.verdict, 'ok');

  const cplus = engine.budget.opticalBudget(Object.assign({}, base, { olt: { model: 'gpon-c-plus-8' } }), registry);
  close(cplus.classHeadroomDb - bplus.classHeadroomDb, 4, 0.001,
    '32 dB - 28 dB: the 4 dB a C+ card buys and a B+ card does not');

  const cplusplus = engine.budget.opticalBudget(Object.assign({}, base, { olt: { model: 'gpon-c-plus-plus-16' } }), registry);
  close(cplusplus.classHeadroomDb - bplus.classHeadroomDb, 7, 0.001,
    '35 dB - 28 dB: the 7 dB a C++ card buys, and the figure a sixteen-port B+ site used to be designed against');
});

done();
