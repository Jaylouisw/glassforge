'use strict';
// The ribbon ladder's smallest rung was 144, so a ribbon ladder answered 144F for every span under
// it: a 96-fibre ribbon trunk bought 144 fibres, and a 48-fibre one bought three times the cable it
// carried. 96 is a stocked ribbon size - eight 12-fibre ribbons - and it is the rung below 144
// (Lightera/Prysmian AccuRibbon DC lists 96 among its standard counts and builds it at 12.8 mm;
// Belden FDSR096R2 is 96F in eight 12F subunits; XCOM's GYTY 96F sheet prints 2,000 m drums).
//
// The pick, the addressing and the drums are driven through the engine, not asserted from the prose.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const design = engine.design;
const fiber = engine.fiber;
const length = engine.length;

// Richest first, the way DEFAULT_LADDER is written - order is a preference, not a match.
const RIBBON_WITHOUT = ['g652d-ribbon-432', 'g652d-ribbon-288', 'g652d-ribbon-216', 'g652d-ribbon-144'];
const RIBBON_WITH = ['g652d-ribbon-432', 'g652d-ribbon-288', 'g652d-ribbon-216', 'g652d-ribbon-144', 'g652d-ribbon-96'];

test('the 96F ribbon rung carries the family figures', function () {
  const part = registry.get('cable', 'g652d-ribbon-96');
  assert.strictEqual(part.fiberCount, 96);
  assert.strictEqual(part.fibersPerTube, 12, 'one ribbon per tube position, as the 144 and 216 rows assume');
  assert.strictEqual(part.construction, 'ribbon');
  assert.strictEqual(part.drumM, 2000, '2 km is the put-up the 96F sheets print');
  assert.deepStrictEqual(part.use, ['feeder']);
  ['1310', '1490', '1550'].forEach(function (nm) {
    assert.ok(part.attenuationDbPerKm[nm] > 0, nm + ' nm attenuation is published');
  });
  const check = engine.parts.validateSpec(part);
  assert.ok(check.ok, 'the row validates: ' + check.errors.join('; '));
});

test('96 fibres address as eight tubes of twelve', function () {
  assert.strictEqual(fiber.tubeCount(96, { fibersPerTube: 12 }), 8, '96 / 12 = 8 tubes');
  const last = fiber.addressFor(96, { fibersPerTube: 12 });
  assert.strictEqual(last.tube, 8, 'strand 96 is in tube 8');
  assert.strictEqual(last.fiber, 12, 'and it is fibre 12 of that tube');
  assert.strictEqual(last.label, 'T08-F12');
});

test('a 96-fibre span buys 96 fibres, not the 144 the ladder used to answer', function () {
  // Without the rung the smallest ribbon that holds 96 is 144: ceil(96 / 144) = 1 bundle, 144 bought.
  const before = design.cableFor(96, RIBBON_WITHOUT, registry);
  assert.strictEqual(before.model, 'g652d-ribbon-144');
  assert.strictEqual(Math.ceil(96 / before.fiberCount) * before.fiberCount, 144, '144 fibres for a 96-fibre demand');

  // With it, the smallest that fits is 96: 1 x 96 = 96 fibres bought.
  const after = design.cableFor(96, RIBBON_WITH, registry);
  assert.strictEqual(after.model, 'g652d-ribbon-96');
  assert.strictEqual(Math.ceil(96 / after.fiberCount) * after.fiberCount, 96, '96 fibres for the same span');
  assert.strictEqual(144 - 96, 48, '48 fibres of cable the rung stops buying on this span');
});

test('the rung does not steal a 120-fibre span from the 144F row', function () {
  // cableFor answers the smallest cable that FITS: 96 does not hold 120, so 144 stays the pick.
  assert.strictEqual(design.cableFor(120, RIBBON_WITH, registry).model, 'g652d-ribbon-144');
  assert.strictEqual(design.cableFor(143, RIBBON_WITH, registry).model, 'g652d-ribbon-144');
  // 48 fibres still round up to 96 - the 48F ribbon rung is a separate increment and this row does
  // not claim it.
  assert.strictEqual(design.cableFor(48, RIBBON_WITH, registry).model, 'g652d-ribbon-96');
});

test('a 1,200 m 96F span buys one 2 km drum and keeps its 764 m spare', function () {
  // 1,200 m x 1.03 overlength = 1,236 m of design length. Drums round once per cable model on the
  // aggregated length: 1,236 m needs one 2,000 m drum, 2,000 - 1,236 = 764 m spare.
  const plant = {
    name: 'Ribbon rung',
    nodes: [
      { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'cab1', type: 'closure', model: 'ocsh-144-cabinet', name: 'Cabinet' },
      { id: 'ont1', type: 'ont', model: 'gpon-ont-4ge', name: '1 Acacia Ave' }
    ],
    spans: [
      { id: 's1', from: 'olt1', to: 'cab1', cable: 'g652d-ribbon-96', lengthM: 1200, strands: [1] },
      { id: 'd1', from: 'cab1', to: 'ont1', cable: 'g657a2-drop-1', lengthM: 40, strands: [1] }
    ]
  };
  const bom = length.billOfMaterials(plant, registry);
  const row = bom.byCable.filter(function (r) { return r.model === 'g652d-ribbon-96'; })[0];
  assert.ok(row, 'the ribbon cable reaches the BOM');
  assert.strictEqual(row.fiberCount, 96, 'the BOM sells the fibre count of the row it picked');
  assert.strictEqual(row.designM, 1236, 'design metres: 1200 x 1.03 = 1236');
  assert.strictEqual(row.drums, 1, 'one 2000 m drum covers 1236 m');
  assert.strictEqual(row.purchaseM, 2000, 'purchase is one whole drum');
  assert.strictEqual(row.spareM, 764, '2000 - 1236 = 764 m spare');
});

done();
