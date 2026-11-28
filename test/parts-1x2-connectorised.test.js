'use strict';
// The 1:2 connectorised cassette. Every other ratio below the 1:128 module - 1:4, 1:8, 1:16, 1:32,
// 1:64 - shipped both a spliced and a connectorised row, and 1:2 was the one that did not, so a
// 1:2-then-1:64 shelf (the 128-way two-stage architecture) had to budget its first stage as a spliced
// chip. plc-1x2-sca's own notes promise the connectorised variant costs "about 0.5 dB more"; this
// suite holds the catalogue to that arithmetic instead of the prose.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const parts = engine.parts;
const network = engine.network;

test('the connectorised 1x2 is the spliced row\'s chip with a terminated input', function () {
  // G.671 WR1 for a 1x2 branching component is 2.8 dB min / 3.9 dB max; this row budgets the typical
  // 3.01 (10*log10(2)) + 0.59 = 3.6 dB, and only the termination differs from plc-1x2-sca.
  const conn = registry.get('splitter', 'plc-1x2-sca-conn');
  const spliced = registry.get('splitter', 'plc-1x2-sca');
  assert.strictEqual(conn.ratio, 2);
  assert.strictEqual(conn.splitLossDb, spliced.splitLossDb, 'the same 1:2 chip, so the same ideal split');
  assert.strictEqual(conn.excessLossDb, spliced.excessLossDb, 'the same chip, so the same excess');
  close(conn.splitLossDb + conn.excessLossDb, 3.6, 0.001, '3.01 + 0.59 dB of chip');
  assert.strictEqual(conn.termination, 'connectorised');
  assert.strictEqual(spliced.termination, 'spliced');
  const check = parts.validateSpec(conn);
  assert.ok(check.ok, 'the row validates: ' + check.errors.join('; '));
});

test('the connectorised 1x2 costs two matings where the spliced one costs one splice', function () {
  function oneSplitter(model) {
    return {
      name: 'Two-stage first stage',
      nodes: [
        { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
        { id: 'n3', type: 'splitter', model: model, name: 'Splitter 1:2' },
        { id: 'n5', type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 1' }
      ],
      spans: [
        { id: 's1', from: 'n1', to: 'n3', cable: 'g652d-loose-12', lengthM: 500 },
        { id: 's2', from: 'n3', to: 'n5', cable: 'g657a2-drop-1', lengthM: 40 }
      ]
    };
  }

  const spliced = network.designForOnt(oneSplitter('plc-1x2-sca'), 'n5', registry);
  const connectorised = network.designForOnt(oneSplitter('plc-1x2-sca-conn'), 'n5', registry);

  assert.strictEqual(spliced.breakdown.filter(function (b) { return b.kind === 'splice'; }).length, 1,
    'one fusion splice on the spliced cassette\'s input tail');
  assert.strictEqual(connectorised.breakdown.filter(function (b) { return b.kind === 'splice'; }).length, 0,
    'no splice in front of a connectorised cassette');
  // 2 x sc-apc (0.3) - 1 x fusion (0.1) = 0.5 dB, the figure plc-1x2-sca's notes quote.
  close(connectorised.odnLossDb - spliced.odnLossDb, (2 * 0.3) - 0.1, 0.01, 'connectorised minus spliced ODN');
  // 540 m at 0.22 = 0.119, chip 3.6, one splice 0.1 and the two end matings every traced path carries
  // (0.6) -> 4.419 dB. The connectorised row swaps that splice for two more matings: 4.919 dB.
  close(spliced.odnLossDb, 4.419, 0.001, 'fibre 0.119 + chip 3.6 + splice 0.1 + ends 0.6');
  close(connectorised.odnLossDb, 4.919, 0.001, 'fibre 0.119 + chip 3.6 + four matings 1.2');
});

test('auto-design still names the spliced 1:2, so no design changes', function () {
  // buildPon resolves a splitter as 'plc-1x' + ratio + '-sca'; if this row were named that, every 1:2
  // candidate would silently start costing 0.5 dB more. The row is hand-select only.
  const built = 'plc-1x' + 2 + '-sca';
  assert.strictEqual(built, 'plc-1x2-sca');
  assert.ok(registry.has('splitter', built), 'the name buildPon constructs is the spliced row');
  assert.notStrictEqual(built, 'plc-1x2-sca-conn', 'the connectorised row is not what the builder names');
});

test('every ratio from 1:2 to 1:128 ships both a spliced and a connectorised cassette', function () {
  // The hole this suite closed: 1:4 through 1:64 had a -conn twin and 1:2 did not, so a hand-drawn
  // plant that terminated its first stage was forced to name a spliced chip or a part nobody sells.
  // A future ratio added on one side only fails here.
  const ratios = [2, 4, 8, 16, 32, 64, 128];
  for (const ratio of ratios) {
    assert.ok(registry.has('splitter', 'plc-1x' + ratio + '-sca'), '1:' + ratio + ' spliced cassette');
    assert.ok(registry.has('splitter', 'plc-1x' + ratio + '-sca-conn'), '1:' + ratio + ' connectorised cassette');
  }
  // This assertion used to read `!registry.has('plc-1x128-sca-conn')`, on the claim that a 1:128 "is
  // not sold as a shelf cassette" and is the last single-chip ratio, so the rule stopped at 1:64.
  // The second half is true (a 1:128 is two chips spliced inside the module) and the first is false:
  // OPTCORE sells PLC-AB-1128-20-SCA-15, a 1x128 SC/APC ABS module at <= 24.6 dB, and LG Optic
  // quotes 1x128 with connectors at <= 24.0 dB. The rule now runs to 1:128;
  // test/parts-1x128-connectorised.test.js holds the row to the chip-plus-two-matings arithmetic.
  assert.ok(registry.has('splitter', 'plc-1x128-sca'));
  assert.ok(registry.has('splitter', 'plc-1x128-sca-conn'), 'the terminated 1:128 exists');
});

done();
