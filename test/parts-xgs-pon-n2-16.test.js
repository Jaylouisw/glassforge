'use strict';
// The XGS-PON OLT ladder was class N1 at sixteen ports, N2 at eight, E1 and E2 at sixteen. A plant is a
// tree with exactly one root (SPEC §1), so an N2 site that needs nine to sixteen PON ports had no row to
// stand on: xgs-pon-n2-8 refuses it by name, and the only sixteen-port XGS-PON rows are E1 (33 dB) and E2
// (35 dB) against N2's 31 - 2 dB and 4 dB of ODN loss, and of launch floor, the bought N2 card never
// buys. xgs-pon-n2-16 is that row: the eight-port N2 card's optics, sixteen ports.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

// Everything about an N2 card except how many ports it carries. A port-count variant that moved any of
// these would be a different part wearing the same class name.
const CLASS_FIELDS = ['pon', 'class', 'txPowerDbmMin', 'txPowerDbmMax', 'rxSensitivityDbm',
  'rxOverloadDbm', 'budgetDb', 'maxSplitRatio'];

test('xgs-pon-n2-16 is the N2 card at sixteen ports, with no optical figure moved', function () {
  const row = registry.get('olt', 'xgs-pon-n2-16');
  const eight = registry.get('olt', 'xgs-pon-n2-8');
  for (const field of CLASS_FIELDS) {
    assert.deepStrictEqual(row[field], eight[field], field + ' must not drift from the 8-port N2 card');
  }
  assert.strictEqual(row.kind, 'olt');
  assert.strictEqual(row.model, 'xgs-pon-n2-16', 'model equals the filename');
  assert.strictEqual(row.ports, 16);
  assert.ok(/^https:\/\//.test(row.sourceUrl || ''), 'an OLT row that sets a class budget names its source');
  assert.ok(/G\.9807\.1/.test(row.notes), 'notes name the recommendation the class figures come from');
  assert.ok(/replace/i.test(row.notes),
    'the caveat that a class figure is not the bought card travels with the row');
});

test('it is the only N2 XGS-PON card with twelve or more ports', function () {
  const fits = registry.all('olt').filter(function (o) {
    return o.pon === 'xgs-pon' && o.class === 'N2' && o.ports >= 12;
  }).sort(function (a, b) {
    return a.ports - b.ports || (a.model < b.model ? -1 : 1);
  });
  // Before this row the catalogue had no N2 card above eight ports at all.
  assert.strictEqual(fits.length, 1, 'N2 rows with at least twelve ports: ' + fits.map(function (o) { return o.model; }).join(', '));
  assert.strictEqual(fits[0].model, 'xgs-pon-n2-16');
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
    pon: { ratios: [32], olt: oltModel, ont: 'xgs-pon-ont-1xge' }
  }, registry);
}

test('a twelve-site N2 estate is refused by the 8-port card by name and designed on the 16-port one', function () {
  const eight = designOn('xgs-pon-n2-8');
  assert.strictEqual(eight.best, null, '8 ports cannot serve 12 splitter sites');
  assert.ok(eight.notes.join(' ').indexOf('needs 12 PON port(s) but xgs-pon-n2-8 has 8') !== -1,
    'the refusal names the port shortage: ' + eight.notes.join('; '));

  const sixteen = designOn('xgs-pon-n2-16');
  const best = sixteen.best;
  assert.ok(best, 'the 16-port card must design the estate the 8-port card refused: ' + sixteen.notes.join('; '));
  const candidate = sixteen.candidates[0];
  assert.strictEqual(candidate.feasible, true);
  assert.strictEqual(candidate.settings.ponPortsNeeded, 12);
  assert.strictEqual(candidate.metrics.splitters, 12);
  const portReasons = candidate.reasons.filter(function (r) { return /PON port/.test(r); });
  assert.strictEqual(portReasons.length, 0, 'no port shortage on a 16-port card');
});

test('the extra ports do not buy another class: the same ODN reads 31 dB, not 33 or 35', function () {
  const base = {
    ont: { model: 'xgs-pon-ont-1xge' },
    wavelength: '1490',
    spans: [{ cable: 'g652d-loose-24', lengthM: 9000 }],
    splitters: [{ model: 'plc-1x32-sca' }],
    splices: 2,
    connectors: 2
  };
  const n2 = engine.budget.opticalBudget(Object.assign({}, base, { olt: { model: 'xgs-pon-n2-16' } }), registry);
  // 9.0 km x 0.22 = 1.98; 2 splices x 0.10 = 0.20; 2 connector pairs x 0.30 = 0.60; plc-1x32 = 17.10
  // -> ODN 19.88 dB; 31 - 19.88 = 11.12 dB of class headroom.
  close(n2.odnLossDb, 19.88, 0.001, 'ODN loss (1.98 + 0.20 + 0.60 + 17.10)');
  close(n2.classHeadroomDb, 11.12, 0.01, 'class headroom against the N2 31 dB budget');
  assert.strictEqual(n2.verdict, 'ok');

  const e1 = engine.budget.opticalBudget(Object.assign({}, base, { olt: { model: 'xgs-pon-e1-16' } }), registry);
  close(e1.classHeadroomDb - n2.classHeadroomDb, 2, 0.001,
    '33 dB - 31 dB: the 2 dB a class E1 card buys and an N2 card does not');

  const e2 = engine.budget.opticalBudget(Object.assign({}, base, { olt: { model: 'xgs-pon-e2-16' } }), registry);
  close(e2.classHeadroomDb - n2.classHeadroomDb, 4, 0.001,
    '35 dB - 31 dB: the 4 dB a class E2 card buys, and the figure a sixteen-port N2 site used to be designed against');
});

done();
