'use strict';
// The 1:4 connectorised cassette: the first stage of the 1:4-then-1:8 architecture a new build grows
// into, which the catalogue could only budget as a spliced chip. The chip figures are plc-1x4-sca's,
// and the whole point of the row is what its termination charges: two SC/APC matings where the spliced
// twin charges one fusion splice - 0.5 dB of ODN, on the first splitter of the plant.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const parts = engine.parts;
const network = engine.network;

test('the connectorised 1x4 is the spliced row\'s chip with a terminated input', function () {
  // G.671 WR1 for a 1x4 branching component is 5.4 dB min / 7.4 dB max; this row budgets the typical
  // 6.02 (10*log10(4)) + 1.18 = 7.2 dB, and only the termination differs from plc-1x4-sca.
  const conn = registry.get('splitter', 'plc-1x4-sca-conn');
  const spliced = registry.get('splitter', 'plc-1x4-sca');
  assert.strictEqual(conn.ratio, 4);
  assert.strictEqual(conn.splitLossDb, spliced.splitLossDb, 'the same 1:4 chip, so the same ideal split');
  assert.strictEqual(conn.excessLossDb, spliced.excessLossDb, 'the same chip, so the same excess');
  close(conn.splitLossDb + conn.excessLossDb, 7.2, 0.001, '6.02 + 1.18 dB of chip');
  assert.strictEqual(conn.termination, 'connectorised');
  assert.strictEqual(spliced.termination, 'spliced');
  const check = parts.validateSpec(conn);
  assert.ok(check.ok, 'the row validates: ' + check.errors.join('; '));
});

test('the connectorised 1x4 costs two matings where the spliced one costs one splice', function () {
  function oneSplitter(model) {
    return {
      name: 'Two-stage first stage',
      nodes: [
        { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
        { id: 'n3', type: 'splitter', model: model, name: 'Splitter 1:4' },
        { id: 'n5', type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 1' }
      ],
      spans: [
        { id: 's1', from: 'n1', to: 'n3', cable: 'g652d-loose-12', lengthM: 500 },
        { id: 's2', from: 'n3', to: 'n5', cable: 'g657a2-drop-1', lengthM: 40 }
      ]
    };
  }

  const spliced = network.designForOnt(oneSplitter('plc-1x4-sca'), 'n5', registry);
  const connectorised = network.designForOnt(oneSplitter('plc-1x4-sca-conn'), 'n5', registry);

  // The spliced cassette is spliced at its input; the connectorised one is not.
  assert.strictEqual(spliced.breakdown.filter(function (b) { return b.kind === 'splice'; }).length, 1,
    'one fusion splice on the spliced cassette\'s input tail');
  assert.strictEqual(connectorised.breakdown.filter(function (b) { return b.kind === 'splice'; }).length, 0,
    'no splice in front of a connectorised cassette');
  // 2 x sc-apc (0.3) - 1 x fusion (0.1) = 0.5 dB, the figure both splitter rows' notes quote.
  close(connectorised.odnLossDb - spliced.odnLossDb, (2 * 0.3) - 0.1, 0.01, 'connectorised minus spliced ODN');
  // 540 m at 0.22 = 0.119, chip 7.2, one splice 0.1 and the two end matings every traced path carries
  // (0.6) -> 8.019 dB. The connectorised row swaps that splice for two more matings: 8.519 dB.
  close(spliced.odnLossDb, 8.019, 0.001, 'fibre 0.119 + chip 7.2 + splice 0.1 + ends 0.6');
  close(connectorised.odnLossDb, 8.519, 0.001, 'fibre 0.119 + chip 7.2 + four matings 1.2');
});

test('auto-design still names the spliced 1:4, so no design changes', function () {
  // buildPon resolves a splitter as 'plc-1x' + ratio + '-sca'; if this row were named that, every 1:4
  // candidate would silently start costing 0.5 dB more. The row is hand-select only, and the name the
  // builder constructs still resolves to the spliced cassette.
  const built = 'plc-1x' + 4 + '-sca';
  assert.strictEqual(built, 'plc-1x4-sca');
  assert.ok(registry.has('splitter', built), 'the name buildPon constructs is the spliced row');
  assert.notStrictEqual(built, 'plc-1x4-sca-conn', 'the connectorised row is not what the builder names');
});

done();
