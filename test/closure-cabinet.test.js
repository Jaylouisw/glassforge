'use strict';
// The validator names six closure types and the catalogue had no part behind one of them: `cabinet`.
// A street cabinet is where a feeder stops being a feeder, so the type has to be real, and the two
// figures the engine reads off it (`ports` against the cables touching it, `spliceCapacity` against
// the strands through it) are different numbers on the same box. The Optimus OCSH rows make that
// difference visible: the 144F distribution cabinet still holds 288 splices, because the tray stack
// is the cabinet's, not the adapter panel's.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const network = engine.network;

test('the cabinet type the validator names has parts, and they are 288-splice boxes', function () {
  const cabinets = registry.all('closure').filter(function (c) { return c.type === 'cabinet'; });
  assert.ok(cabinets.length >= 1, 'no closure in the catalogue has type "cabinet"');
  const ports = cabinets.map(function (c) { return c.ports; }).sort(function (a, b) { return a - b; });
  // Channell OCSH: 288F distribution (288 ports) and the 144F-distribution variant. Both carry the
  // family's 288 splices in 16 Universal Splice Trays, which is the figure under test.
  assert.deepStrictEqual(ports, [144, 288], 'cabinet port counts: ' + JSON.stringify(ports));
  for (const c of cabinets) {
    assert.strictEqual(c.spliceCapacity, 288, c.model + ' holds ' + c.spliceCapacity + ' splices, not 288');
    assert.strictEqual(c.trays, 16, c.model + ' has ' + c.trays + ' trays');
  }
});

/** OLT -<288F ribbon>-> cabinet -<288F ribbon>-> handhole -<drop>-> ONT. 288 through-splices. */
function ribbonJoint(cabinetModel) {
  return {
    name: 'Cabinet joint',
    nodes: [
      { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'cab1', type: 'closure', model: cabinetModel, name: 'Cabinet' },
      { id: 'hh1', type: 'closure', model: 'handhole-4', name: 'Handhole' },
      { id: 'ont1', type: 'ont', model: 'gpon-ont-1ge', name: 'Casa 1' }
    ],
    spans: [
      { id: 's1', from: 'olt1', to: 'cab1', cable: 'g652d-ribbon-288', lengthM: 900 },
      { id: 's2', from: 'cab1', to: 'hh1', cable: 'g652d-ribbon-288', lengthM: 400 },
      { id: 'sd', from: 'hh1', to: 'ont1', cable: 'g657a2-drop-1', lengthM: 40 }
    ]
  };
}

test('288 strands through the 288-splice cabinet are at capacity, not over it', function () {
  // capacity 288, strands 288: the check is `inThisClosure > closure.spliceCapacity`, so equal is a
  // pass. A box that warned here would refuse every 288F feeder the catalogue sells.
  const r = network.designForOnt(ribbonJoint('ocsh-288-cabinet'), 'ont1', registry);
  assert.deepStrictEqual(r.notes, []);
});

test('the 144F distribution cabinet still holds the 288 splices: ports are not splices', function () {
  // The trap the row exists to state: 144 is the adapter count, 288 is the tray stack. A design that
  // read 144 as the splice figure would buy a bigger cabinet for a joint this one already holds.
  const r = network.designForOnt(ribbonJoint('ocsh-144-cabinet'), 'ont1', registry);
  assert.deepStrictEqual(r.notes, []);
});

/** One feeder into the cabinet, then `drops` single-fibre drop cables out of it to as many ONTs. */
function cabinetWithDrops(cabinetModel, drops) {
  const nodes = [
    { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
    { id: 'cab1', type: 'closure', model: cabinetModel, name: 'Cabinet' }
  ];
  const spans = [{ id: 's0', from: 'olt1', to: 'cab1', cable: 'g652d-loose-48', lengthM: 500 }];
  for (let i = 1; i <= drops; i++) {
    nodes.push({ id: 'ont' + i, type: 'ont', model: 'gpon-ont-1ge', name: 'Casa ' + i });
    spans.push({ id: 'sd' + i, from: 'cab1', to: 'ont' + i, cable: 'g657a2-drop-1', lengthM: 40 });
  }
  return { name: 'Cabinet drops', nodes: nodes, spans: spans };
}

function cabinetWarnings(plant) {
  return network.validate(plant, registry).warnings.filter(function (w) {
    return w.indexOf('cables into') !== -1;
  });
}

test('144 cables into the 144-port cabinet are exactly its ports, with no warning', function () {
  // 143 drops plus the feeder is 144 cables touching the node; ports 144, so the comparison
  // `touching > closure.ports` is equal and silent.
  assert.deepStrictEqual(cabinetWarnings(cabinetWithDrops('ocsh-144-cabinet', 143)), []);
});

test('the 145th cable into the 144-port cabinet is named with both numbers', function () {
  const w = cabinetWarnings(cabinetWithDrops('ocsh-144-cabinet', 144));
  assert.strictEqual(w.length, 1, 'one port warning: ' + JSON.stringify(w));
  assert.ok(w[0].indexOf('145 cables into 144 ports') !== -1, 'counts cables and portraits ports: ' + w[0]);
  assert.ok(w[0].indexOf('"Cabinet"') !== -1, 'names the node: ' + w[0]);
});

test('the 288-port cabinet takes the 145th cable without a word', function () {
  // The same plant against the bigger cabinet: 145 <= 288, so the only difference the port count
  // makes is whether the box is named.
  assert.deepStrictEqual(cabinetWarnings(cabinetWithDrops('ocsh-288-cabinet', 144)), []);
});

done();
