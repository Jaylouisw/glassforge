'use strict';
// An active network has no splitter, and the budget has to say so rather than budget around it.
//
// SPEC 8 puts "a splitter in an active plant" in the list of things the engine refuses to guess, and
// `network.validate` refuses it. The budget did not: `designForOnt` builds an ACTIVE design with
// `headEnd` + `cpe` and no `splitters` list (an active design has no such field), so a splitter node on
// the traced path was walked past. Its spliced termination still added its tail splice - 0.10 dB - and
// its insertion loss, 10.50 dB, was never charged at all.
//
// That is reachable: `POST /budget` reads a stored project, and a project file written before the
// save-time validation existed can hold a headend root with a splitter under it. Measured on main
// before this file, with A - 1 km - splitter - 1 km - B on 100G-LR4 at 1310 nm:
//
//   fibre      2 km x 0.35 dB/km          =  0.70 dB
//   connectors 2 x 0.30                   =  0.60 dB
//   splice     1 (splitter's input tail)   =  0.10 dB
//                                            --------
//   ODN loss reported                     =  1.40 dB   -> verdict "marginal", nothing wrong
//
// and the same plant as a PON charges 0.44 + 10.50 (splitter) + 0.10 + 0.60 = 11.64 dB, ten decibels
// more, because a PON design carries the splitter in its own list. A link that is 10.5 dB short cannot
// be reported as one that hears, so the active path now refuses the path by node.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

const HEAD = 'qsfp28-100g-lr4-10km';
const OLT = 'gpon-c-plus-8';
const ONT = 'gpon-ont-4ge';

/** A - 1 km - splitter - 1 km - B, the same shape under either root. */
function plantWithSplitter(root) {
  const rootNode = root === 'headend'
    ? { id: 'root', type: 'headend', model: HEAD, name: 'A' }
    : { id: 'root', type: 'olt', model: OLT, name: 'OLT' };
  return {
    id: 'p1',
    name: 'one splitter between the ends',
    nodes: [
      rootNode,
      { id: 'sp1', type: 'splitter', model: 'plc-1x8-sca', name: 'SPL 1:8' },
      { id: 'o1', type: 'ont', model: root === 'headend' ? HEAD : ONT, name: 'B' }
    ],
    spans: [
      { id: 's1', from: 'root', to: 'sp1', cable: 'g652d-loose-12', lengthM: 1000, strands: [1] },
      { id: 's2', from: 'sp1', to: 'o1', cable: 'g652d-loose-12', lengthM: 1000, strands: [1] }
    ]
  };
}

// ------------------------------------------------------------------ the plant check already says it

test('validate refuses a splitter under a headend root', function () {
  const check = engine.network.validate(plantWithSplitter('headend'), registry);
  assert.strictEqual(check.ok, false);
  assert.ok(
    check.errors.some(function (e) { return /cannot contain a splitter/.test(e); }),
    'expected the active-network splitter refusal, got ' + JSON.stringify(check.errors)
  );
});

// ------------------------------------------------------------------ the budget refuses it too

test('designForOnt refuses a splitter on an active path, naming the node and the ONT', function () {
  const err = throws(function () {
    engine.network.designForOnt(plantWithSplitter('headend'), 'o1', registry, {});
  }, 'cannot contain a splitter', 'designForOnt');
  assert.ok(String(err.message).indexOf('"sp1"') !== -1, 'the refusal should name the splitter node: ' + err.message);
  assert.ok(String(err.message).indexOf('"o1"') !== -1, 'the refusal should name the ONT it was asked about: ' + err.message);
});

test('a splitter with no model on an active path is refused by the same rule, not for a missing model', function () {
  const plant = plantWithSplitter('headend');
  plant.nodes[1] = { id: 'sp1', type: 'splitter', name: 'SPL unmodelled' };
  throws(function () {
    engine.network.designForOnt(plant, 'o1', registry, {});
  }, 'cannot contain a splitter', 'designForOnt with an unmodelled splitter');
});

test('the budget list reports an error row, never a verdict, for that ONT', function () {
  const rows = engine.network.allOntBudgets(plantWithSplitter('headend'), registry, {});
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ont, 'o1');
  assert.ok(rows[0].error, 'expected an error row, got a result: ' + JSON.stringify(rows[0]));
  assert.strictEqual(rows[0].result, undefined, 'a refused ONT must not carry a verdict as well');
  assert.ok(rows[0].error.indexOf('splitter') !== -1, rows[0].error);
});

// ------------------------------------------------------------------ the PON is untouched

test('the same topology under an OLT still budgets, with the splitter loss charged', function () {
  // fibre 2 km x 0.22 = 0.44; splitter 9.03 + 1.47 = 10.50; input-tail splice 1 x 0.10;
  // connectors 2 x 0.30 = 0.60 -> 11.64 dB, inside the C+ 32 dB budget.
  const result = engine.network.designForOnt(plantWithSplitter('olt'), 'o1', registry, {});
  assert.strictEqual(result.technology, 'pon');
  close(result.odnLossDb, 11.64, 0.01, 'ODN loss');
  assert.strictEqual(result.cascadeRatio, 8, 'one 1:8 splitter is a 1:8 cascade');
});

test('an active path with no splitter is unchanged: 2 km of G.652.D and two connectors', function () {
  // The same plant with the splitter removed: 0.70 fibre + 0.60 connectors = 1.30 dB.
  const plant = {
    id: 'p2',
    name: 'two sites, one span',
    nodes: [
      { id: 'root', type: 'headend', model: HEAD, name: 'A' },
      { id: 'o1', type: 'ont', model: HEAD, name: 'B' }
    ],
    spans: [{ id: 's1', from: 'root', to: 'o1', cable: 'g652d-loose-12', lengthM: 2000, strands: [1] }]
  };
  const result = engine.network.designForOnt(plant, 'o1', registry, {});
  assert.strictEqual(result.technology, 'p2p');
  close(result.odnLossDb, 1.3, 0.01, 'ODN loss');
  assert.strictEqual(result.verdict, 'ok');
});

done();
