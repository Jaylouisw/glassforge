'use strict';
// The ribbon ladder was 216 / 288 / 432. The feeder ladder's richest entry is g652d-loose-144, so a
// plant asking for, say, 120 fibres on a ribbon ladder resolved to the 216F rung and bought 216
// fibres for a 120-fibre span - 72 fibres of cable that no design asked for, on every span in that
// band. 144 is the rung between the two, and it is the size a ribbon cable is actually sold at
// (twelve ribbons of twelve: Belden FDSR144R2 is '144 Fibers 12F Subs', Prysmian's nbn
// F144S2RCTNNBNV2 is 12 ribbons at 12 fibres, STL's Celesta HD IBR 144F packs 2 km drums).
//
// This suite holds the catalogue to that arithmetic rather than to the prose: the pick, the
// addressing and the drums are all driven through the engine.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const design = engine.design;
const fiber = engine.fiber;
const length = engine.length;

// Richest first, the way DEFAULT_LADDER is written - order is a preference, not a match.
const RIBBON_WITHOUT = ['g652d-ribbon-432', 'g652d-ribbon-288', 'g652d-ribbon-216'];
const RIBBON_WITH = ['g652d-ribbon-432', 'g652d-ribbon-288', 'g652d-ribbon-216', 'g652d-ribbon-144'];

test('the 144F ribbon rung carries the family figures', function () {
  const part = registry.get('cable', 'g652d-ribbon-144');
  assert.strictEqual(part.fiberCount, 144);
  assert.strictEqual(part.fibersPerTube, 12, 'one ribbon per tube position, as g652d-ribbon-216 assumes');
  assert.strictEqual(part.construction, 'ribbon');
  assert.strictEqual(part.drumM, 2000, '2 km is the put-up the 144F sheets print');
  assert.deepStrictEqual(part.use, ['feeder']);
  // A window with no figure is a window the engine refuses to budget, so all three are published.
  ['1310', '1490', '1550'].forEach(function (nm) {
    assert.ok(part.attenuationDbPerKm[nm] > 0, nm + ' nm attenuation is published');
  });
  const check = engine.parts.validateSpec(part);
  assert.ok(check.ok, 'the row validates: ' + check.errors.join('; '));
});

test('144 fibres address as twelve tubes of twelve, the way a 12x12 ribbon is built', function () {
  assert.strictEqual(fiber.tubeCount(144, { fibersPerTube: 12 }), 12, '144 / 12 = 12 tubes');
  const last = fiber.addressFor(144, { fibersPerTube: 12 });
  assert.strictEqual(last.tube, 12, 'strand 144 is in tube 12');
  assert.strictEqual(last.fiber, 12, 'and it is fibre 12 of that tube');
  assert.strictEqual(last.label, 'T12-F12');
});

test('a 120-fibre span buys 144 fibres, not the 216 the ladder used to answer', function () {
  // cableFor answers the SMALLEST cable that fits. Without the rung the smallest ribbon that holds
  // 120 is 216: ceil(120 / 216) = 1 bundle, 1 x 216 = 216 fibres bought.
  const before = design.cableFor(120, RIBBON_WITHOUT, registry);
  assert.strictEqual(before.model, 'g652d-ribbon-216');
  assert.strictEqual(Math.ceil(120 / before.fiberCount) * before.fiberCount, 216, '216 fibres for a 120-fibre demand');

  // With it, the smallest is 144: ceil(120 / 144) = 1 bundle, 1 x 144 = 144 fibres bought.
  const after = design.cableFor(120, RIBBON_WITH, registry);
  assert.strictEqual(after.model, 'g652d-ribbon-144');
  assert.strictEqual(Math.ceil(120 / after.fiberCount) * after.fiberCount, 144, '144 fibres for the same span');
  assert.strictEqual(216 - 144, 72, '72 fibres of cable the rung stops buying on this span');
});

test('a 1,200 m 144F span buys one 2 km drum and keeps its 764 m spare', function () {
  // 1,200 m x 1.03 overlength = 1,236 m of design length. Drums round once per cable model on the
  // aggregated length, and 1,236 m needs one 2,000 m drum: 2,000 - 1,236 = 764 m spare.
  const plant = {
    name: 'Ribbon rung',
    nodes: [
      { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'cab1', type: 'closure', model: 'ocsh-144-cabinet', name: 'Cabinet' },
      { id: 'ont1', type: 'ont', model: 'gpon-ont-4ge', name: '1 Acacia Ave' }
    ],
    spans: [
      { id: 's1', from: 'olt1', to: 'cab1', cable: 'g652d-ribbon-144', lengthM: 1200, strands: [1] },
      { id: 'd1', from: 'cab1', to: 'ont1', cable: 'g657a2-drop-1', lengthM: 40, strands: [1] }
    ]
  };
  const bom = length.billOfMaterials(plant, registry);
  const row = bom.byCable.filter(function (r) { return r.model === 'g652d-ribbon-144'; })[0];
  assert.ok(row, 'the ribbon cable reaches the BOM');
  assert.strictEqual(row.fiberCount, 144, 'the BOM sells the fibre count of the row it picked');
  assert.strictEqual(row.designM, 1236, 'design metres: 1200 x 1.03 = 1236');
  assert.strictEqual(row.drums, 1, 'one 2000 m drum covers 1236 m');
  assert.strictEqual(row.purchaseM, 2000, 'purchase is one whole drum');
  assert.strictEqual(row.spareM, 764, '2000 - 1236 = 764 m spare');
});

done();
