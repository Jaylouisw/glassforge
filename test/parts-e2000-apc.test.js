'use strict';
// The E2000/APC rows. The catalogue carried SC, LC and MPO in both grades and no E2000 at all, so a
// plant that hands over on E2000 adapters - the shutter-protected push-pull footprint European carrier
// ODFs commonly present - had only sc-apc to name: the right loss number on the wrong part, and a BOM
// that buys SC/APC patch cords for an E2000 panel. Two rows fix the part number; one of them also moves
// a verdict, and both claims are driven here rather than asserted in a note.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const parts = engine.parts;
const network = engine.network;
const budget = engine.budget;

// OLT - 500 m feeder - connectorised 1:8 - 40 m drop - ONT. designForOnt charges two end matings plus
// two for a connectorised splitter, so every path below carries four matings.
const FOUR_MATINGS = {
  name: 'Four matings',
  nodes: [
    { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
    { id: 'n3', type: 'splitter', model: 'plc-1x8-sca-conn', name: 'Splitter 1:8' },
    { id: 'n5', type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 1' }
  ],
  spans: [
    { id: 's1', from: 'n1', to: 'n3', cable: 'g652d-loose-12', lengthM: 500 },
    { id: 's2', from: 'n3', to: 'n5', cable: 'g657a2-drop-1', lengthM: 40 }
  ]
};

function budgetWith(connectorModel) {
  const opts = connectorModel ? { connectorModel: connectorModel } : {};
  return network.designForOnt(FOUR_MATINGS, 'n5', registry, opts);
}

function connectorLine(result) {
  const lines = result.breakdown.filter(function (b) { return b.kind === 'connector'; });
  assert.strictEqual(lines.length, 1, 'one aggregated connector line, got ' + lines.length);
  return lines[0];
}

test('both E2000 rows validate and sit on the published grade figures', function () {
  const standard = registry.get('connector', 'e2000-apc');
  const graded = registry.get('connector', 'e2000-apc-lowloss');
  for (const row of [standard, graded]) {
    const check = parts.validateSpec(row);
    assert.ok(check.ok, row.model + ' validates: ' + check.errors.join('; '));
    assert.strictEqual(row.polish, 'apc',
      row.model + ' is ' + row.polish + ': E2000 is bought in APC, and a UPC ferrule is another row');
  }
  // IEC 61753-1:2007 Table A.12 / ITU-T L.36 Table 9-1, the table sc-apc and sc-apc-lowloss are built
  // on: grade C is 0.25 mean / 0.50 max, grade B is 0.12 mean / 0.25 max.
  assert.strictEqual(standard.lossDb, 0.3, 'e2000-apc charges the grade-C figure sc-apc charges');
  assert.strictEqual(standard.maxLossDb, 0.5, 'e2000-apc ceiling is grade C');
  assert.strictEqual(graded.lossDb, 0.15, 'e2000-apc-lowloss charges 0.15 dB typical per mating');
  assert.strictEqual(graded.maxLossDb, 0.25, 'e2000-apc-lowloss ceiling is grade B');
});

test('naming e2000-apc changes the part on the order, not the budget', function () {
  const sc = budgetWith('sc-apc');
  const e2000 = budgetWith('e2000-apc');
  // Four matings x 0.30 = 1.2 dB either way: same grade-C figure, different plug.
  close(connectorLine(e2000).db, 4 * 0.3, 0.001, 'four e2000-apc matings');
  close(e2000.odnLossDb - sc.odnLossDb, 0, 0.000001, 'ODN must not move for a footprint swap');
  // 540 m at 0.22 = 0.1188, 1:8 chip 10.5, four matings 1.2 -> 11.8188 dB; the C+ receiver at the +1.5 dBm
  // launch floor against a -30 dBm ONT reads 21.18 dB of headroom.
  close(e2000.odnLossDb, 11.8188, 0.001, 'fibre 0.1188 + chip 10.5 + matings 1.2');
  close(e2000.headroomDb, 21.18, 0.01, '1.5 + 30 - 11.8188 - 3 dB margin');
  assert.strictEqual(e2000.verdict, 'ok', 'a C+ short line is ok on either row');
});

test('the plan prints the E2000 row, which is the whole point of the row', function () {
  // A connector row that never reaches the breakdown adds a number nobody reads. The label is built from
  // part.model in engine/budget.js, so this fails if the row is addressed but not named.
  const line = connectorLine(budgetWith('e2000-apc'));
  assert.strictEqual(line.label, '4 x e2000-apc connector',
    'the breakdown must name the part a buyer has to order, got "' + line.label + '"');
  const graded = connectorLine(budgetWith('e2000-apc-lowloss'));
  assert.strictEqual(graded.label, '4 x e2000-apc-lowloss connector',
    'the grade-B row must be distinguishable from the grade-C one in the BOM');
});

test('the grade-B E2000 pair takes 0.60 dB off four matings', function () {
  const standard = budgetWith('e2000-apc');
  const graded = budgetWith('e2000-apc-lowloss');
  // 4 x (0.30 - 0.15) = 0.60 dB.
  close(standard.odnLossDb - graded.odnLossDb, 0.6, 0.001, 'ODN delta over four matings');
  close(graded.odnLossDb, 11.2188, 0.001, 'fibre 0.1188 + chip 10.5 + matings 0.6');
  close(graded.headroomDb - standard.headroomDb, 0.6, 0.001, 'headroom moves by the same 0.6 dB');
});

test('on a B+ 1:32 line the grade-B row is the difference between marginal and ok', function () {
  // The example e2000-apc-lowloss's notes quote, driven: gpon-b-plus-8, connectorised 1:32, 24.0 km of
  // feeder plus a 40 m drop. 1:32 chip 17.1, fibre 24040 m x 0.22 = 5.2888, matings 1.2 -> 23.5888 dB.
  function longLine(lengthM, model) {
    return network.designForOnt({
      name: 'B+ 1:32 long line',
      nodes: [
        { id: 'n1', type: 'olt', model: 'gpon-b-plus-8', name: 'OLT' },
        { id: 'n3', type: 'splitter', model: 'plc-1x32-sca-conn', name: 'Splitter 1:32' },
        { id: 'n5', type: 'ont', model: 'gpon-ont-b-plus-4ge', name: 'Casa 1' }
      ],
      spans: [
        { id: 's1', from: 'n1', to: 'n3', cable: 'g652d-loose-12', lengthM: lengthM },
        { id: 's2', from: 'n3', to: 'n5', cable: 'g657a2-drop-1', lengthM: 40 }
      ]
    }, 'n5', registry, { connectorModel: model });
  }
  const marginal = longLine(24000, 'e2000-apc');
  const ok = longLine(24000, 'e2000-apc-lowloss');
  close(marginal.odnLossDb, 23.5888, 0.001, 'chip 17.1 + fibre 5.2888 + matings 1.2');
  assert.strictEqual(marginal.verdict, 'marginal', 'grade C at 24.0 km is marginal, headroom 4.91 dB');
  close(marginal.headroomDb, 4.91, 0.01, 'launch floor 1.5 and sensitivity -27 give 4.91 dB');
  close(ok.odnLossDb, 22.9888, 0.001, 'same plant, 0.6 dB of matings traded for grade B');
  assert.strictEqual(ok.verdict, 'ok', 'the grade-B row buys the 0.6 dB that makes it ok');
  close(ok.headroomDb, 5.51, 0.01, '4.91 + 0.6 = 5.51 dB');

  const failing = longLine(33000, 'e2000-apc');
  const rescued = longLine(33000, 'e2000-apc-lowloss');
  assert.strictEqual(failing.verdict, 'fail', 'grade C at 33.0 km fails the 28 dB class');
  close(failing.headroomDb, 2.93, 0.01, '2.93 dB is under the 3 dB margin');
  assert.strictEqual(rescued.verdict, 'marginal', 'grade B moves the same plant to marginal');
  close(rescued.headroomDb, 3.53, 0.01, '2.93 + 0.6 = 3.53 dB');
});

test('an active link names the E2000 row through budget.pointToPoint', function () {
  // 10GBASE-LR is a 6.2 dB budget and 8.0 km of G.652.D at 0.35 dB/km is 2.800 dB of fibre.
  function active(model) {
    return budget.pointToPoint({
      headEnd: { model: 'sfp-plus-10g-lr-10km' },
      cpe: { model: 'sfp-plus-10g-lr-10km' },
      spans: [{ lengthM: 8000, cable: 'g652d-loose-24' }],
      connectors: { model: model, count: 2 },
      marginDb: 3
    }, registry);
  }
  // 2.800 + 2 x 0.30 = 3.40 -> 6.2 - 3.40 = 2.8 dB, under the margin; grade B is 3.10 / 3.1 dB.
  close(active('e2000-apc').odnLossDb, 3.4, 0.001, 'fibre 2.8 + two 0.30 matings');
  close(active('e2000-apc').headroomDb, 2.8, 0.01, '6.2 - 3.40');
  assert.strictEqual(active('e2000-apc').verdict, 'fail', 'grade C at 8.0 km is under the 3 dB margin');
  close(active('e2000-apc-lowloss').odnLossDb, 3.1, 0.001, 'fibre 2.8 + two 0.15 matings');
  assert.strictEqual(active('e2000-apc-lowloss').verdict, 'marginal',
    'grade B buys the 0.3 dB that clears the 3 dB margin');
});

test('nothing already budgeted moved: sc-apc is still the default connector', function () {
  // The rows are hand-select only. A plant with no connectorModel must budget the 0.30 dB default, or
  // every stored project silently changes its headroom the day a connector row is added.
  const implicit = budgetWith(undefined);
  const explicit = budgetWith('sc-apc');
  close(implicit.odnLossDb, explicit.odnLossDb, 0.000001, 'absent connectorModel = sc-apc');
  close(connectorLine(implicit).db, 4 * 0.3, 0.001, 'still 0.30 dB per mating');
  assert.strictEqual(connectorLine(implicit).label, '4 x sc-apc connector',
    'the default still names sc-apc, not the newest APC row');
});

done();
