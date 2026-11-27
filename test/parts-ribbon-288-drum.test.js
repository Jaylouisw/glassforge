'use strict';
// A drum length is a property of the CABLE, and the BOM rounds once per cable model on the
// aggregated design length (docs/SPEC.md invariant: drums round once, per model). That makes
// `drumM` a purchasing figure, not a cosmetic one: it decides how many reels go on the order and
// how many joints the crew makes.
//
// g652d-ribbon-288 carried `drumM: 1000` from the first import, with nothing in its notes saying
// where the number came from, while every other feeder row here is 2000 m. 1 km is not a put-up a
// 288-fibre ribbon cable is sold on: Prysmian's Sirocco data sheet (GB00_Sirocco, 12-288F outdoor
// microduct) states "Standard delivery length is 2 km. Maximum delivery length is 6 km", and the
// FusionLink FlexRibbon sheet (TS08019, 144/288F ribbon) states "Standard Delivery Length: 4 km.
// Other delivery lengths are available". A 900 m + 400 m trunk through a cabinet therefore bought
// TWO 1 km drums where the catalogue's own cable is supplied as ONE 2 km drum - the BOM ordered a
// reel nobody sells, and the joint count followed it.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const length = engine.length;

test('the 288-fibre ribbon buys on the 2 km drum its makers publish, not a 1 km reel', function () {
  const part = registry.get('cable', 'g652d-ribbon-288');
  assert.strictEqual(part.drumM, 2000, 'g652d-ribbon-288 drum length: ' + part.drumM + ' m');
});

test('two ribbon spans through a cabinet aggregate to one 2 km drum, not two 1 km ones', function () {
  // 900 m x 1.03 overlength = 927 m, 400 m x 1.03 = 412 m: designM 1339 m for the model.
  // One drum of 2000 m covers it (drums round once on the aggregate); it read 2 drums / 2000 m
  // while drumM was 1000.
  const plant = {
    name: 'Ribbon joint',
    nodes: [
      { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'cab1', type: 'closure', model: 'ocsh-288-cabinet', name: 'Cabinet' }
    ],
    spans: [
      { id: 's1', from: 'olt1', to: 'cab1', cable: 'g652d-ribbon-288', lengthM: 900 },
      { id: 's2', from: 'cab1', to: 'olt1', cable: 'g652d-ribbon-288', lengthM: 400 }
    ]
  };
  const bom = length.billOfMaterials(plant, registry);
  const row = bom.byCable.filter(function (r) { return r.model === 'g652d-ribbon-288'; })[0];
  assert.ok(row, 'the ribbon cable reaches the BOM');
  assert.strictEqual(row.drumM, 2000, 'BOM drum length comes from the part');
  assert.strictEqual(row.designM, 1339, 'design metres: 927 + 412 = 1339');
  assert.strictEqual(row.drums, 1, 'one 2000 m drum covers 1339 m');
  assert.strictEqual(row.purchaseM, 2000, 'purchase is one whole drum');
});

done();
