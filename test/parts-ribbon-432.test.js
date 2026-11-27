'use strict';
// `cableFor` answers with the largest rung when nothing in the ladder carries the count, so with the
// catalogue topping out at the 288-fibre ribbon a span needing 300 fibres was designed on a cable
// twelve fibres short (auto-design bundles it and warns; a link refuses and names the 288 as the only
// way out). 432 is the smallest ribbon count Corning publishes above 288 that a closure in this
// catalogue can joint, so it is the rung that closes the 289..432 hole without selling a cable no box
// can splice: the largest closure here is the FOSC 600-D at 504 splices, and 576 > 504.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const design = engine.design;

test('the catalogue carries a 432-fibre ribbon that cableFor picks for 289..432 fibres', function () {
  const part = registry.get('cable', 'g652d-ribbon-432');
  assert.strictEqual(part.fiberCount, 432, 'the rung carries 432 fibres');
  assert.strictEqual(part.construction, 'ribbon', 'it is a ribbon, not a loose tube');
  // 432 = 18 ribbons of 24 fibres (Corning 432ZV4-14100D53), each separable to two 12-fibre ribbons,
  // so the tray address is the 12-fibre ribbon, which is what fibersPerTube publishes.
  assert.strictEqual(part.fibersPerTube, 12, 'a 432F ribbon addresses twelve fibres per tube');
  const ladder = ['g652d-ribbon-432', 'g652d-ribbon-288'];
  for (const n of [289, 300, 400, 432]) {
    assert.strictEqual(design.cableFor(n, ladder, registry).model, 'g652d-ribbon-432', n + ' fibres');
  }
});

test('the 432 rung never displaces the 288 for a count that fits the smaller cable', function () {
  const ladder = ['g652d-ribbon-432', 'g652d-ribbon-288'];
  assert.strictEqual(design.cableFor(200, ladder, registry).model, 'g652d-ribbon-288', '200 fibres');
  assert.strictEqual(design.cableFor(288, ladder, registry).model, 'g652d-ribbon-288', '288 fibres, full');
});

test('past 432 the largest rung is still bought short, and that is the ladder fallback not a fit', function () {
  // Documented engine behaviour (engine/link.js refuses the same count by name): pinned here so nobody
  // reads the new rung as "the catalogue now carries any count".
  const over = design.cableFor(500, ['g652d-ribbon-432'], registry);
  assert.strictEqual(over.fiberCount, 432, '500 fibres on a 432-fibre rung: the fallback, twelve short');
});

test('the 432-fibre ribbon buys on the 2 km reel the family is sold on', function () {
  const part = registry.get('cable', 'g652d-ribbon-432');
  assert.strictEqual(part.drumM, 2000, 'g652d-ribbon-432 drum length: ' + part.drumM + ' m');
  const plant = {
    nodes: [{ id: 'n1', type: 'olt', model: 'gpon-c-plus-8' }, { id: 'n2', type: 'ont', model: 'gpon-ont-1ge' }],
    spans: [{ id: 's1', from: 'n1', to: 'n2', cable: 'g652d-ribbon-432', lengthM: 1500 }]
  };
  const bom = engine.length.billOfMaterials(plant, registry, { overlengthPct: 0 });
  assert.strictEqual(bom.byCable[0].drums, 1, '1,500 m is one 2 km drum');
});

done();
