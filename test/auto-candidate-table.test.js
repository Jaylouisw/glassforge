'use strict';
// The Auto tab's candidate table omitted the numbers that decided it.
//
// It was a hand-written header in `app.js` and a hand-written cell list beside it, so the table could
// only ever show the figures somebody remembered to add. Two the response carries were missing:
//
// 1. `metrics.cost` - when a `costs` model is supplied the engine ranks by money and says so in
//    `objective`, and the table showed cable metres and fibre-metres instead. A plan chosen for
//    9,328 was compared on a column that is not the ranking.
// 2. `metrics.upstreamFailOnts` - a PON is two links over one ODN, and the winning candidate on the
//    12-house C+ estate below (PON 1:8, best by fibre-metres) has 12 of 12 ONTs failing upstream
//    while its 1:16 and 1:32 neighbours have 0 of 12 (#185). The design is still offered - whether
//    the upstream direction should gate feasibility is the open decision in #185, not this table's
//    call - but the count has to be visible where the candidate is chosen.
//
// The table is now `web/auto.js`: one key list builds the header and the row, so a column cannot be
// in one and missing from the other, and this suite drives it with the payloads the engine really
// answers rather than with a hand-made object.
const { test, assert, close, done } = require('./harness');
const fs = require('fs');
const path = require('path');
const engine = require('../engine');
const auto = require('../web/auto');

const registry = engine.createRegistry();

/** The same 12-house street `design-launch-window.test.js` uses: a short C+ estate. */
function estate(n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({ label: 'House ' + (i + 1), lat: 51.5 + i * 0.0004, lon: -0.1 + Math.sin(i / 5) * 0.0004 });
  }
  return points;
}

const NEAR = { lat: 51.499, lon: -0.1006, name: 'PoP' };
const FAR = { lat: 51.35, lon: -0.1006, name: 'PoP' };

const near = engine.design.synthesise(estate(12), { headEnd: NEAR }, registry);
const far = engine.design.synthesise(estate(12), { headEnd: FAR }, registry);

// Every cable priced, so the money ranking has no unpriced model to refuse (that refusal is a
// design-suite case of its own). The price is arbitrary and only has to be a number.
function prices() {
  const out = {};
  registry.all('cable').forEach(function (cable) { out[cable.model] = 1 + cable.fiberCount / 10; });
  return out;
}
const costed = engine.design.synthesise(estate(12), {
  headEnd: NEAR,
  costs: { cablePerM: prices(), splice: 8, closure: 150, splitter: 400 }
}, registry);

function candidateNamed(result, prefix) {
  const found = result.candidates.filter(function (c) { return c.label.indexOf(prefix) === 0; });
  assert.strictEqual(found.length, 1, 'expected one candidate labelled "' + prefix + '", got ' + found.length);
  return found[0];
}

test('the header and every row are the same length, for both objectives', function () {
  const designs = [{ result: near, objective: 'fibre-metres' }, { result: far, objective: 'fibre-metres' }, { result: costed, objective: 'cost' }];
  for (const design of designs) {
    const columns = auto.columns(design.objective);
    assert.strictEqual(design.result.objective, design.objective, 'the engine named a different objective');
    for (const candidate of design.result.candidates) {
      const cells = auto.cells(candidate, design.objective);
      assert.strictEqual(cells.length, columns.length,
        candidate.label + ': ' + cells.length + ' cells under ' + columns.length + ' headers');
      assert.strictEqual(cells[0].text, candidate.label, 'the first column is the topology, not ' + cells[0].text);
      assert.strictEqual(cells[1].text, candidate.feasible ? 'yes' : 'no', candidate.label + ': feasible cell');
    }
  }
});

test('the money column appears only when money is the ranking, and carries the ranked figure', function () {
  const labels = function (objective) { return auto.columns(objective).map(function (c) { return c.label; }); };
  assert.strictEqual(labels('fibre-metres').indexOf('Cost'), -1, 'a fibre-metres ranking must not show a cost column');
  // Directly after Fibre-m, where the two numbers are compared: 8 columns before it, so index 4.
  assert.strictEqual(labels('cost').indexOf('Cost'), 4, labels('cost').join(' | '));
  const best = costed.candidates[0];
  assert.ok(best.metrics.cost !== null, 'the ranked design has no cost: ' + best.label);
  const costIndex = labels('cost').indexOf('Cost');
  const costCell = auto.cells(best, 'cost')[costIndex];
  assert.strictEqual(costCell.text, String(best.metrics.cost),
    'the cell is the number the ranking used, not a re-rounded copy: ' + costCell.text);
});

test('the upstream direction of every ONT is on the row, and it does not move the verdict', function () {
  const win8 = candidateNamed(near, 'PON 1:8');
  // 12 houses behind a C+ card and a 1:8: every ONT launches +0.5 dBm into an OLT receiver whose
  // overload is -12 dBm, so all twelve fail upstream while the design is feasible downstream.
  assert.strictEqual(win8.metrics.upstreamFailOnts, 12, JSON.stringify(win8.metrics));
  assert.strictEqual(win8.feasible, true, 'this suite is about a feasible design with a failed direction');
  const cells = auto.cells(win8, 'fibre-metres');
  const upIndex = auto.columns('fibre-metres').map(function (c) { return c.label; }).indexOf('Up fail');
  assert.ok(upIndex !== -1, 'the Up fail column is missing');
  assert.strictEqual(cells[upIndex].text, '12', 'the cell is the engine count: ' + cells[upIndex].text);
  assert.ok(cells[upIndex].cls.indexOf('warn') !== -1, 'a failed direction is flagged: ' + cells[upIndex].cls);
  assert.ok(cells[upIndex].cls.indexOf('err') === -1,
    'a warning, not an error: the candidate is still offered, and the decision to gate it is #185');
  assert.strictEqual(cells[1].text, 'yes', 'the direction count must not turn the candidate infeasible');

  // The 1:16 on the same estate is clean upstream: 18.5 dB of splitter loss keeps the OLT inside its
  // overload point, so the column is the discriminator between two candidates the metre count prefers.
  const win16 = candidateNamed(near, 'PON 1:16');
  assert.strictEqual(win16.metrics.upstreamFailOnts, 0, JSON.stringify(win16.metrics));
  const clean = auto.cells(win16, 'fibre-metres')[upIndex];
  assert.strictEqual(clean.text, '0');
  assert.strictEqual(clean.cls, 'num', 'a clean direction carries no flag: ' + clean.cls);
});

test('an older payload with no upstream count shows a dash, not a zero', function () {
  const stale = {
    label: 'PON 1:8 (2019 report)',
    feasible: true,
    metrics: { onts: 4, cableM: 400, fibreMetres: 1200, closures: 2, splitters: 1, worstHeadroomDb: 18.4, cost: null }
  };
  const cells = auto.cells(stale, 'fibre-metres');
  const upIndex = auto.columns('fibre-metres').map(function (c) { return c.label; }).indexOf('Up fail');
  assert.strictEqual(cells[upIndex].text, '\u2014', 'no figure is a dash, never 0: ' + cells[upIndex].text);
  assert.strictEqual(cells[upIndex].cls, 'num', 'and it is not flagged: ' + cells[upIndex].cls);
});

test('the served page loads the module, and the table is built only through it', function () {
  const web = path.join(__dirname, '..', 'web');
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  assert.ok(html.indexOf('src="/auto.js"') !== -1, 'index.html does not load /auto.js');
  assert.ok(html.indexOf('/auto.js') < html.indexOf('/app.js'), 'the module must load before the app uses it');
  const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
  assert.ok(app.indexOf('GFAuto.columns(') !== -1, 'renderAuto does not ask the module for its columns');
  assert.ok(app.indexOf('GFAuto.cells(') !== -1, 'renderAuto does not ask the module for its cells');
  // The old table, by its own header list: a second column list is how the cost and upstream figures
  // went missing, and a regex over one string is enough here because the string is the whole defect.
  assert.strictEqual(app.indexOf("'Topology', 'Feasible'"), -1, 'app.js still carries a hand-written header');
});

done();
