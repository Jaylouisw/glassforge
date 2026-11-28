'use strict';
// The 1:128 connectorised module. The catalogue's completeness rule - every ratio ships a spliced
// row and a connectorised twin - stopped at 1:64, on the claim (asserted in
// parts-1x2-connectorised.test.js) that a 1:128 "is not sold as a shelf cassette". That claim is
// false: OPTCORE sells PLC-AB-1128-20-SCA-15, a 1x128 PLC in an ABS module with SC/APC connectors,
// insertion loss <= 24.6 dB, and LG Optic quotes 1x128 at <= 24.0 dB with connectors (<= 23.8
// without). So a hand-drawn 1:128 whose CO stage arrives terminated had to name a spliced chip and
// understate the ODN by the 0.5 dB difference between one fusion splice and two SC/APC matings.
// This suite holds the new row to that arithmetic.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const parts = engine.parts;
const network = engine.network;

test('the connectorised 1x128 is the spliced row\'s chip with a terminated input', function () {
  // Same two-chip 1:128 as plc-1x128-sca: ideal split 10*log10(128) = 21.07 dB plus 2.73 dB excess
  // = 23.8 dB chip, the Precision OT figure the spliced row carries. Only the termination differs.
  const conn = registry.get('splitter', 'plc-1x128-sca-conn');
  const spliced = registry.get('splitter', 'plc-1x128-sca');
  assert.ok(conn, 'the connectorised 1:128 row loads');
  assert.strictEqual(conn.ratio, 128);
  assert.strictEqual(conn.splitLossDb, spliced.splitLossDb, 'the same 1:128 chip, so the same ideal split');
  assert.strictEqual(conn.excessLossDb, spliced.excessLossDb, 'the same chip, so the same excess');
  close(conn.splitLossDb + conn.excessLossDb, 23.8, 0.001, '21.07 + 2.73 dB of chip');
  assert.strictEqual(conn.termination, 'connectorised');
  assert.strictEqual(spliced.termination, 'spliced');
  const check = parts.validateSpec(conn);
  assert.ok(check.ok, 'the row validates: ' + check.errors.join('; '));
});

test('the connectorised 1x128 costs two matings where the spliced one costs one splice', function () {
  function oneSplitter(model) {
    return {
      name: 'One 1:128 stage',
      nodes: [
        { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
        { id: 'n3', type: 'splitter', model: model, name: 'Splitter 1:128' },
        { id: 'n5', type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 1' }
      ],
      spans: [
        { id: 's1', from: 'n1', to: 'n3', cable: 'g652d-loose-12', lengthM: 500 },
        { id: 's2', from: 'n3', to: 'n5', cable: 'g657a2-drop-1', lengthM: 40 }
      ]
    };
  }

  const spliced = network.designForOnt(oneSplitter('plc-1x128-sca'), 'n5', registry);
  const connectorised = network.designForOnt(oneSplitter('plc-1x128-sca-conn'), 'n5', registry);

  assert.strictEqual(spliced.breakdown.filter(function (b) { return b.kind === 'splice'; }).length, 1,
    'one fusion splice on the spliced cassette\'s input tail');
  assert.strictEqual(connectorised.breakdown.filter(function (b) { return b.kind === 'splice'; }).length, 0,
    'no splice in front of a connectorised cassette');
  // 2 x sc-apc (0.3) - 1 x fusion (0.1) = 0.5 dB, the figure the spliced 1:128 row's notes promise.
  close(connectorised.odnLossDb - spliced.odnLossDb, (2 * 0.3) - 0.1, 0.01, 'connectorised minus spliced ODN');
  // 500 m at 0.22 = 0.11 dB, 40 m at 0.22 = 0.0088 dB, chip 23.8, one splice 0.1 and the two end
  // matings every traced path carries (0.6) -> 24.6188 dB. The connectorised row swaps that splice
  // for two more matings: 25.1188 dB.
  close(spliced.odnLossDb, 24.6188, 0.001, 'fibre 0.1188 + chip 23.8 + splice 0.1 + ends 0.6');
  close(connectorised.odnLossDb, 25.1188, 0.001, 'fibre 0.1188 + chip 23.8 + four matings 1.2');
  // C+ launches 3.0 dBm into a -32 dBm receiver with a 32 dB class budget: 25.12 dB still lights
  // and still fits the class, which is the reason a terminated 1:128 is designable at all.
  assert.strictEqual(connectorised.verdict, 'ok');
});

done();
