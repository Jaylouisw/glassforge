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

test('a project name that is not a string is refused, because it is printed', function () {
  // The rename op has always stringified; `createProject` and `PUT` copied `name` through unchanged,
  // so an object or an array saved. It is JSON-safe, so nothing complained until `/print/project/:id`
  // rendered "[object Object] - plan". A name is a string, or absent - a design candidate has none.
  const p = base();
  p.name = { a: 1 };
  assert.deepStrictEqual(engine.network.validate(p, registry).errors,
    ['the project name must be a string, got an object']);
  p.name = ['x'];
  assert.deepStrictEqual(engine.network.validate(p, registry).errors,
    ['the project name must be a string, got an array']);
  p.name = 'Barrio Norte phase 2';
  assert.deepStrictEqual(engine.network.validate(p, registry).errors, []);
  delete p.name;
  assert.deepStrictEqual(engine.network.validate(p, registry).errors, [],
    'a plant with no name at all is what a design candidate looks like');
});

test('exactly one OLT: a second root is refused at plant level, with or without an ONT', function () {
  // With an ONT in the plant the per-ONT trace notices the ambiguity too, so a needle match alone
  // passes for the wrong reason: it must be the *plant-level* refusal, quoted verbatim.
  const p = base();
  p.nodes.push({ id: 'n9', type: 'olt', model: 'gpon-c-plus-8' });
  const withOnt = engine.network.validate(p, registry);
  assert.strictEqual(withOnt.ok, false, 'two OLTs must refuse the save');
  assert.ok(withOnt.errors.indexOf('exactly one olt or headend node is required, found 2') !== -1,
    'plant-level refusal expected, got: ' + withOnt.errors.join(' | '));
  assert.ok(!withOnt.errors.some(function (e) { return e.indexOf('ont "') === 0; }),
    'a root-count fault belongs to the plant, not to a customer ONT: ' + withOnt.errors.join(' | '));

  // And the fixture no ONT can speak for: two OLTs and nothing else. This is what makes the
  // plant-level guard load-bearing - weaken it and this plant validates clean, which is the bug.
  const bare = {
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', lat: 51.5, lon: -0.1 },
      { id: 'n2', type: 'olt', model: 'gpon-c-plus-8', lat: 51.5, lon: -0.1 }
    ],
    spans: []
  };
  const noOnt = engine.network.validate(bare, registry);
  assert.strictEqual(noOnt.ok, false, 'two OLTs and no ONT must still refuse the save');
  assert.deepStrictEqual(noOnt.errors, ['exactly one olt or headend node is required, found 2'],
    'one plant-level error, found: ' + noOnt.errors.join(' | '));
});

test('capacity refuses to pick one of two OLTs', function () {
  // `stats` and `project.summary` run on projects that were never validated, so the derived numbers
  // cannot rely on the save having been refused. Reporting the first OLT's ports for a plant with
  // two of them is how an ambiguous plant reads as healthy on the signal page.
  const twoRoots = {
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8' },
      { id: 'n2', type: 'olt', model: 'gpon-c-plus-16' }
    ],
    spans: []
  };
  const cap = engine.network.capacity(twoRoots, registry);
  assert.strictEqual(cap.ports, null, 'capacity must not report the ports of one of two OLTs');
  assert.strictEqual(cap.theoreticalMaxOnts, null, 'nor a maximum derived from one of them');
  assert.ok(cap.problems.some(function (p) { return p.indexOf('exactly one olt/headend root') !== -1; }),
    'capacity should say the plant has two roots, got: ' + cap.problems.join(' | '));
  assert.ok(engine.network.stats(twoRoots, registry).capacity.problems.length > 0,
    'stats must carry the same refusal, not a number');
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

test('a span splice count that is not a count is refused, naming the span and the field', function () {
  // `billOfMaterials` feeds span.splices straight into cableToBuy, which refuses text. Nothing
  // checked the field at save time, so a plant with splices: 'two' validated clean and every /bom
  // call for it was a 500 - the server blamed for the caller's own typo.
  const p = base();
  p.spans[0].splices = 'two';
  const result = engine.network.validate(p, registry);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.errors, ['span "s1" has an invalid splices count "two"']);
});

test('a negative or fractional count is refused too - a count is a whole number', function () {
  const negative = base();
  negative.spans[1].closures = -1;
  assert.deepStrictEqual(engine.network.validate(negative, registry).errors,
    ['span "s2" has an invalid closures count "-1"']);
  const fractional = base();
  fractional.spans[0].splices = 2.5;
  assert.deepStrictEqual(engine.network.validate(fractional, registry).errors,
    ['span "s1" has an invalid splices count "2.5"']);
});

test('a splice list and a zero count are counts the BOM can price, so they validate', function () {
  // cableToBuy counts a splice list by its length, so a list already prices and must not become a
  // refusal here. 900 m + 3% overlength (27 m) + 2 x 30 m splice reserve = 987 m design length.
  const p = base();
  p.spans[0].splices = [{ model: 'fusion' }, { model: 'fusion' }];
  p.spans[1].closures = 0;
  assert.deepStrictEqual(engine.network.validate(p, registry).errors, []);
  assert.strictEqual(engine.length.billOfMaterials(p, registry, {}).lines[0].designM, 987);
});

test('a bundles count that is not a positive whole number is refused at the write gate', function () {
  // `bundles` is how many cables run a span (auto-design sets it when the fibres do not fit one
  // cable). It is read by the BOM and the strand ledger, so `0` would buy no cable for a span that is
  // drawn on the map and `1.5` is not a cable count. Refused by span and by field, like splices.
  const zero = base();
  zero.spans[0].bundles = 0;
  assert.deepStrictEqual(engine.network.validate(zero, registry).errors,
    ['span "s1" has an invalid bundles count "0"']);
  const fractional = base();
  fractional.spans[1].bundles = 1.5;
  assert.deepStrictEqual(engine.network.validate(fractional, registry).errors,
    ['span "s2" has an invalid bundles count "1.5"']);
  const good = base();
  good.spans[0].bundles = 2;
  assert.deepStrictEqual(engine.network.validate(good, registry).errors, []);
});

done();
