'use strict';
// The path is what a budget, a splice diagram and a cable order all derive from, so it is traced
// and asserted rather than trusted.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const network = engine.network;

function plant(overrides) {
  return Object.assign({
    name: 'Test build',
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'n2', type: 'closure', model: 'mufa-inline-24', name: 'Mufa 1' },
      { id: 'n3', type: 'splitter', model: 'plc-1x8-sca', name: 'Splitter 1:8' },
      { id: 'n4', type: 'closure', model: 'nap-8', name: 'NAP 12' },
      { id: 'n5', type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 30' }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 1200 },
      { id: 's2', from: 'n2', to: 'n3', cable: 'g652d-loose-12', lengthM: 300 },
      { id: 's3', from: 'n3', to: 'n4', cable: 'g652d-loose-12', lengthM: 200 },
      { id: 's4', from: 'n4', to: 'n5', cable: 'g657a2-drop-1', lengthM: 60 }
    ]
  }, overrides || {});
}

test('the trace walks OLT to ONT in order', function () {
  const path = network.trace(plant(), 'n5');
  assert.deepStrictEqual(path.nodes.map(function (n) { return n.id; }), ['n1', 'n2', 'n3', 'n4', 'n5']);
  assert.deepStrictEqual(path.spans.map(function (s) { return s.id; }), ['s1', 's2', 's3', 's4']);
});

test('a traced path becomes a budget with the parts on it', function () {
  const r = network.designForOnt(plant(), 'n5', registry);
  assert.strictEqual(r.olt, 'gpon-c-plus-8');
  assert.strictEqual(r.ont, 'gpon-ont-4ge');
  assert.strictEqual(r.cascadeRatio, 8);
  assert.strictEqual(r.breakdown.filter(function (b) { return b.kind === 'fibre'; }).length, 4);
  // 2 closures on the path -> 2 through-splices; the spliced splitter adds one -> 3; connectors 2.
  close(r.odnLossDb, (1.2 * 0.22) + (0.3 * 0.22) + (0.2 * 0.22) + (0.06 * 0.22) + (3 * 0.1) + (2 * 0.3) + 10.5, 0.01, 'ODN loss');
  assert.deepStrictEqual(r.path.map(function (n) { return n.id; }), ['n1', 'n2', 'n3', 'n4', 'n5']);
});

test('every ONT gets a verdict, and one broken ONT does not hide the rest', function () {
  const p = plant();
  p.nodes.push({ id: 'n6', type: 'ont', model: 'gpon-ont-1ge', name: 'Orphan' });
  const results = network.allOntBudgets(p, registry);
  assert.strictEqual(results.length, 2);
  assert.ok(results.find(function (r) { return r.ont === 'n5'; }).result.verdict);
  assert.ok(results.find(function (r) { return r.ont === 'n6'; }).error.indexOf('not connected') !== -1);
});

test('asking for an ONT that is not an ONT is refused', function () {
  throws(function () { network.trace(plant(), 'n2'); }, 'not an ont');
  throws(function () { network.trace(plant(), 'nope'); }, 'no node with id');
});

test('a plant with two OLTs cannot be traced', function () {
  const p = plant();
  p.nodes.push({ id: 'n9', type: 'olt', model: 'gpon-c-plus-8', name: 'Second OLT' });
  throws(function () { network.trace(p, 'n5'); }, 'exactly one olt');
});

test('a connectorised splitter costs connectors instead of a splice', function () {
  const p = plant({ nodes: [
    { id: 'n1', type: 'olt', model: 'gpon-c-plus-8' },
    { id: 'n3', type: 'splitter', model: 'plc-1x8-sca', name: 'Splitter' },
    { id: 'n5', type: 'ont', model: 'gpon-ont-4ge' }
  ], spans: [
    { id: 's1', from: 'n1', to: 'n3', cable: 'g652d-loose-12', lengthM: 500 },
    { id: 's2', from: 'n3', to: 'n5', cable: 'g657a2-drop-1', lengthM: 40 }
  ] });
  const spliced = network.designForOnt(p, 'n5', registry);
  const spliceLines = spliced.breakdown.filter(function (b) { return b.kind === 'splice'; });
  assert.strictEqual(spliceLines.length, 1, 'the spliced splitter contributes one splice');
  assert.ok(spliceLines[0].label.indexOf('1 x') !== -1);
});

test('capacity reports the cascade and the ONT budget against the OLT', function () {
  const cap = network.capacity(plant(), registry);
  assert.strictEqual(cap.ports, 8);
  assert.strictEqual(cap.maxSplitRatio, 128);
  assert.strictEqual(cap.splitterCascade, 8);
  assert.strictEqual(cap.onts, 1);
  assert.strictEqual(cap.theoreticalMaxOnts, 8 * 128);
  assert.deepStrictEqual(cap.problems, []);
});

test('stats add up the route', function () {
  const stats = network.stats(plant(), registry);
  close(stats.routeM, 1760, 0.01, 'route');
  close(stats.routeKm, 1.76, 0.001, 'route km');
  assert.strictEqual(stats.onts, 1);
  assert.strictEqual(stats.closures, 2);
});

done();
