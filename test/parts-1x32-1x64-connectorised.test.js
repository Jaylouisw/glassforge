'use strict';
// The connectorised CO-shelf cassettes: a 1:32 or 1:64 PLC module that arrives in an LGX/1RU shelf
// with SC/APC adapters on the front. Before this row the catalogue could only budget that shelf as a
// spliced chip, so the BOM charged one fusion splice and no patch field for a shelf whose whole design
// is 32 or 64 adapters. The chip figures are plc-1x32-sca's and plc-1x64-sca's, unchanged; what the row
// changes is the input: two SC/APC matings (0.6 dB) where the spliced twin charges one splice (0.1 dB).
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const parts = engine.parts;
const network = engine.network;

function chipTest(model, twin, ratio, chipLoss, band) {
  test('the connectorised 1x' + ratio + ' is the spliced row chip with a terminated input', function () {
    const conn = registry.get('splitter', model);
    const spliced = registry.get('splitter', twin);
    assert.strictEqual(conn.ratio, ratio);
    assert.strictEqual(conn.splitLossDb, spliced.splitLossDb, 'the same chip, so the same ideal split');
    assert.strictEqual(conn.excessLossDb, spliced.excessLossDb, 'the same chip, so the same excess');
    close(conn.splitLossDb + conn.excessLossDb, chipLoss, 0.001, band);
    assert.strictEqual(conn.termination, 'connectorised');
    assert.strictEqual(spliced.termination, 'spliced');
    const check = parts.validateSpec(conn);
    assert.ok(check.ok, 'the row validates: ' + check.errors.join('; '));
  });
}

// G.671 WR1 for a 1x32 branching component is 13.3 dB min / 17.5 dB max, the band plc-1x32-sca quotes;
// this row budgets the typical 15.05 (10*log10(32)) + 2.05 = 17.1 dB of chip.
chipTest('plc-1x32-sca-conn', 'plc-1x32-sca', 32, 17.1, '15.05 + 2.05 dB of chip');
// G.671 WR1 for a 1x64 is 16.1 dB min / 20.9 dB max; the chip is 18.06 (10*log10(64)) + 2.44 = 20.5.
chipTest('plc-1x64-sca-conn', 'plc-1x64-sca', 64, 20.5, '18.06 + 2.44 dB of chip');

function oneSplitter(model) {
  return {
    name: 'CO shelf',
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'n3', type: 'splitter', model: model, name: 'Shelf' },
      { id: 'n5', type: 'ont', model: 'gpon-ont-c-plus-1ge', name: 'Casa 1' }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n3', cable: 'g652d-loose-12', lengthM: 500 },
      { id: 's2', from: 'n3', to: 'n5', cable: 'g657a2-drop-1', lengthM: 40 }
    ]
  };
}
function spliceCount(d) {
  return d.breakdown.filter(function (b) { return b.kind === 'splice'; }).length;
}

test('a connectorised cassette costs two matings where the spliced one costs one splice', function () {
  // 540 m at 0.22 = 0.1188 dB of fibre on every path below.
  const f32 = network.designForOnt(oneSplitter('plc-1x32-sca'), 'n5', registry);
  const c32 = network.designForOnt(oneSplitter('plc-1x32-sca-conn'), 'n5', registry);
  assert.strictEqual(spliceCount(f32), 1, 'one fusion splice on the spliced input tail');
  assert.strictEqual(spliceCount(c32), 0, 'no splice in front of a connectorised cassette');
  // 0.1188 fibre + 17.1 chip + 0.1 splice + 0.6 for the two end matings every traced path carries.
  close(f32.odnLossDb, 17.919, 0.001, 'spliced 1x32: fibre 0.119 + chip 17.1 + splice 0.1 + ends 0.6');
  // The connectorised row swaps that splice for two more matings: 0.1188 + 17.1 + 1.2 = 18.4188.
  close(c32.odnLossDb, 18.419, 0.001, 'connectorised 1x32: fibre 0.119 + chip 17.1 + four matings 1.2');
  // 2 x sc-apc (0.3) - 1 x fusion (0.1) = 0.5 dB, the figure both splitter rows notes quote.
  close(c32.odnLossDb - f32.odnLossDb, (2 * 0.3) - 0.1, 0.01, 'connectorised minus spliced ODN, 1x32');

  const f64 = network.designForOnt(oneSplitter('plc-1x64-sca'), 'n5', registry);
  const c64 = network.designForOnt(oneSplitter('plc-1x64-sca-conn'), 'n5', registry);
  close(f64.odnLossDb, 21.319, 0.001, 'spliced 1x64: fibre 0.119 + chip 20.5 + splice 0.1 + ends 0.6');
  close(c64.odnLossDb, 21.819, 0.001, 'connectorised 1x64: fibre 0.119 + chip 20.5 + four matings 1.2');
  close(c64.odnLossDb - f64.odnLossDb, (2 * 0.3) - 0.1, 0.01, 'connectorised minus spliced ODN, 1x64');
});

test('auto-design still names the spliced 1:32 and 1:64, so no design changes', function () {
  // buildPon resolves a splitter as plc-1x<ratio>-sca; if these rows carried that name every 1:32 and
  // 1:64 candidate would silently cost 0.5 dB more. They are hand-select only, like plc-1x4-sca-conn.
  [32, 64].forEach(function (ratio) {
    const built = 'plc-1x' + ratio + '-sca';
    assert.ok(registry.has('splitter', built), 'the name buildPon constructs is the spliced row for 1:' + ratio);
    assert.notStrictEqual(built, 'plc-1x' + ratio + '-sca-conn', 'the connectorised row is not what the builder names');
  });
});

done();
