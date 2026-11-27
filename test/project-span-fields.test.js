'use strict';
// `add-span` used to rebuild the span from a fixed field list — id, from, to, cable, lengthM,
// strands, splices, closures, route — and silently drop everything else the plant model carries.
// `bundles` is the one that costs money: `length.billOfMaterials` multiplies the measured route by
// it, so a 1.2 km span that really runs two 144-fibre cables was priced as one and the purchase was
// half the cable. Measured through the API before this test, `add-span { bundles: 2,
// dropReserveM: 50 }` answered 200 with a span carrying neither field, and `/bom` quoted
// designM 1236 (1200 x 1.03) instead of 2522 (1200 x 2 x 1.03 + 50) - one drum instead of two.
// `PUT` keeps both fields from the same body, and the validator refuses `bundles: 0` by name, so the
// op path was the only writer that could lose them. A dropped field is worse than a refused one: the
// caller sees a 200 and the number is quietly short.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

function projectWithOlt() {
  const project = engine.project.createProject('Span fields', { id: 'p-span-fields' });
  const olt = engine.project.apply(project, { op: 'add-node', node: { id: 'n1', type: 'olt', model: 'gpon-c-plus-8' } });
  assert.ok(!olt.error, olt.error);
  const closure = engine.project.apply(olt.project, { op: 'add-node', node: { id: 'n2', type: 'closure', model: 'nap-8' } });
  assert.ok(!closure.error, closure.error);
  return closure.project;
}

test('an add-span keeps the bundle count the BOM prices', function () {
  const applied = engine.project.apply(projectWithOlt(), {
    op: 'add-span',
    span: { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-144', lengthM: 1200, strands: [1, 2, 3], bundles: 2 }
  });
  assert.ok(!applied.error, applied.error);
  assert.strictEqual(applied.project.spans[0].bundles, 2, 'add-span dropped the bundle count');
  // 1200 m x 2 cables = 2400, + 3% overlength = 2472; two whole 2000 m drums = 4000 m.
  const bom = engine.length.billOfMaterials(applied.project, registry, {});
  assert.strictEqual(bom.lines[0].designM, 2472, 'the span line should price both cables');
  assert.strictEqual(bom.byCable[0].purchaseM, 4000, 'one cable of a two-cable span is half the order');
  assert.strictEqual(bom.byCable[0].drums, 2);
});

test('an add-span keeps the additional reserve the BOM charges', function () {
  const applied = engine.project.apply(projectWithOlt(), {
    op: 'add-span',
    span: { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 1000, dropReserveM: 50 }
  });
  assert.ok(!applied.error, applied.error);
  assert.strictEqual(applied.project.spans[0].dropReserveM, 50, 'add-span dropped the additional reserve');
  // 1000 + 3% = 1030, + 50 reserve = 1080.
  const bom = engine.length.billOfMaterials(applied.project, registry, {});
  assert.strictEqual(bom.lines[0].designM, 1080, 'the reserve the caller named is missing from the order');
});

test('an add-span keeps the purpose the splice schedule reads', function () {
  const applied = engine.project.apply(projectWithOlt(), {
    op: 'add-span',
    span: { id: 's1', from: 'n2', to: 'n1', cable: 'g657a2-drop-1', lengthM: 1, purpose: 'splitter-tail' }
  });
  assert.ok(!applied.error, applied.error);
  assert.strictEqual(applied.project.spans[0].purpose, 'splitter-tail', 'add-span dropped the purpose');
});

test('a bundle count the plant cannot hold is refused by name, not dropped', function () {
  // `isBundleCount` refuses zero because it would buy no cable for a span drawn on the map, and the
  // validator already says so on PUT. Reading the op through the same rule is what stops a 200 from
  // hiding the field.
  [0, -1, 1.5, '2', null].forEach(function (bad) {
    const applied = engine.project.apply(projectWithOlt(), {
      op: 'add-span',
      span: { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-144', lengthM: 1200, bundles: bad }
    });
    assert.ok(applied.error, 'bundles ' + JSON.stringify(bad) + ' was accepted');
    assert.ok(applied.error.indexOf('bundles') !== -1, 'the refusal should name bundles: ' + applied.error);
    assert.ok(!applied.project, 'a refused op must not hand back a project');
  });
});

test('a reserve that is not metres is refused by name, not dropped', function () {
  ['50', -5].forEach(function (bad) {
    const applied = engine.project.apply(projectWithOlt(), {
      op: 'add-span',
      span: { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 100, dropReserveM: bad }
    });
    assert.ok(applied.error, 'dropReserveM ' + JSON.stringify(bad) + ' was accepted');
    assert.ok(applied.error.indexOf('dropReserveM') !== -1, 'the refusal should name dropReserveM: ' + applied.error);
  });
});

test('a purpose that is not a word is refused by name', function () {
  const applied = engine.project.apply(projectWithOlt(), {
    op: 'add-span',
    span: { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 100, purpose: { name: 'x' } }
  });
  assert.ok(applied.error, 'an object purpose was accepted');
  assert.ok(applied.error.indexOf('purpose') !== -1, 'the refusal should name purpose: ' + applied.error);
});

done();
