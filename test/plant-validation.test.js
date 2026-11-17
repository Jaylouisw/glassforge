'use strict';
// A save is refused for structural nonsense; warnings are the things a planner should look at.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

function base() {
  return {
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', lat: 51.5, lon: -0.1 },
      { id: 'n2', type: 'splitter', model: 'plc-1x8-sca', lat: 51.501, lon: -0.1 },
      { id: 'n3', type: 'ont', model: 'gpon-ont-4ge', lat: 51.502, lon: -0.1 }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 900 },
      { id: 's2', from: 'n2', to: 'n3', cable: 'g657a2-drop-1', lengthM: 40 }
    ]
  };
}

test('a well-formed plant validates', function () {
  const result = engine.network.validate(base(), registry);
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.warnings, []);
});

test('exactly one OLT', function () {
  const p = base();
  p.nodes.push({ id: 'n9', type: 'olt', model: 'gpon-c-plus-8' });
  assert.ok(engine.network.validate(p, registry).errors.some(function (e) { return e.indexOf('exactly one olt') !== -1; }));
});

test('unknown models are errors, except a closure which only warns', function () {
  const p = base();
  p.nodes[1].model = 'splitter-does-not-exist';
  assert.ok(engine.network.validate(p, registry).errors.some(function (e) { return e.indexOf('unknown splitter model') !== -1; }));

  const q = base();
  q.nodes.splice(1, 0, { id: 'n5', type: 'closure', model: 'mystery-box' });
  q.spans = [
    { id: 's1', from: 'n1', to: 'n5', cable: 'g652d-loose-12', lengthM: 500 },
    { id: 's2', from: 'n5', to: 'n2', cable: 'g652d-loose-12', lengthM: 400 },
    { id: 's3', from: 'n2', to: 'n3', cable: 'g657a2-drop-1', lengthM: 40 }
  ];
  const result = engine.network.validate(q, registry);
  assert.deepStrictEqual(result.errors, []);
  assert.ok(result.warnings.some(function (w) { return w.indexOf('unknown closure model') !== -1; }));
});

test('a span with no length is an error: the BOM depends on it', function () {
  const p = base();
  p.spans[0].lengthM = 0;
  assert.ok(engine.network.validate(p, registry).errors.some(function (e) { return e.indexOf('no measured length') !== -1; }));
});

test('duplicate ids are errors', function () {
  const p = base();
  p.nodes.push({ id: 'n1', type: 'ont', model: 'gpon-ont-1ge' });
  assert.ok(engine.network.validate(p, registry).errors.some(function (e) { return e.indexOf('duplicate node id') !== -1; }));
  const q = base();
  q.spans.push({ id: 's1', from: 'n1', to: 'n3', cable: 'g657a2-drop-1', lengthM: 10 });
  assert.ok(engine.network.validate(q, registry).errors.some(function (e) { return e.indexOf('duplicate span id') !== -1; }));
});

test('an over-split PON is an error, because the OLT will not light it', function () {
  const p = base();
  p.nodes[1].model = 'plc-1x64-sca';
  p.nodes.push({ id: 'n4', type: 'splitter', model: 'plc-1x8-sca' });
  p.spans = [
    { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 900 },
    { id: 's2', from: 'n2', to: 'n4', cable: 'g652d-loose-12', lengthM: 100 },
    { id: 's3', from: 'n4', to: 'n3', cable: 'g657a2-drop-1', lengthM: 40 }
  ];
  const result = engine.network.validate(p, registry);
  assert.ok(result.errors.some(function (e) { return e.indexOf('cascade') !== -1; }), result.errors.join(' | '));
});

test('an unconnected node is a warning, not a refusal', function () {
  const p = base();
  p.nodes.push({ id: 'n7', type: 'ont', model: 'gpon-ont-1ge', name: 'Floating' });
  const result = engine.network.validate(p, registry);
  assert.deepStrictEqual(result.errors, []);
  assert.ok(result.warnings.some(function (w) { return w.indexOf('not connected') !== -1; }), result.warnings.join(' | '));
});

test('a long drop is a warning', function () {
  const p = base();
  p.spans[1].lengthM = 900;
  assert.ok(engine.network.validate(p, registry).warnings.some(function (w) { return w.indexOf('check the run') !== -1; }));
});

done();
