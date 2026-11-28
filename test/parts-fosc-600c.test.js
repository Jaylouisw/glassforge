'use strict';
// The feeder ladder sells 48-, 96- and 144-fibre cable, and the catalogue had exactly two in-line
// joints: mufa-inline-24 (24 splices) and fosc-600d-inline-504 (504). A through-joint in a 96F or 144F
// cable therefore read as over-stuffed in the mufa, and the only boxes that fitted were a street
// cabinet - a different product, not a joint - or a 35 mm trunk closure built for a 288F trunk. This
// suite holds the FOSC 600-C row to the job it exists for: it is the first in-line closure that holds
// MORE than a 144F joint - the 144 itself is fosc-450b6-inline-144 - and it does not pretend to be the
// 288F box.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const network = engine.network;

test('the FOSC 600-C row is 3 D trays of 72 splices, not a rounder number', function () {
  const c = registry.get('closure', 'fosc-600c-inline-216');
  // CommScope PA-317451.2-AE (05/16), 'Tray (and splice) capacity of closures': 600 C In-line =
  // 3 trays (216 splices). 3 x 72 = 216, and 72 is the D tray with six SM12 modules.
  assert.strictEqual(c.type, 'inline');
  assert.strictEqual(c.spliceCapacity, 216, '3 trays x 72 splices');
  assert.strictEqual(c.trays, 3);
  assert.strictEqual(c.ports, 4, 'one 4-port gel block is the base order code, as on the 600-D row');
});

test('it is the first in-line closure ABOVE a 144F joint, which now has its own 144-splice rung', function () {
  const inlines = registry.all('closure').filter(function (c) { return c.type === 'inline'; });
  const bigger = inlines.filter(function (c) { return c.spliceCapacity > 144; })
    .sort(function (a, b) { return a.spliceCapacity - b.spliceCapacity || (a.model < b.model ? -1 : 1); });
  assert.ok(bigger.length >= 1, 'no in-line closure holds more than 144 splices');
  // This used to assert that 216 was the smallest capacity at or above 144 - true while the ladder
  // jumped 96 -> 216 and a 144F joint bought 72 unused positions. fosc-450b6-inline-144 seats the
  // 144F through-joint exactly (held by test/parts-fosc-450b6.test.js), so this row's claim is now
  // the rung above: the first box for a chamber that splices more than one 144F cable.
  assert.strictEqual(bigger[0].model, 'fosc-600c-inline-216', 'smallest box above 144 splices: ' + bigger[0].model);
  assert.strictEqual(bigger[0].spliceCapacity, 216, '3 trays x 72 = 216, the first capacity above 144');
});

/** OLT -<feeder>-> joint -<feeder>-> handhole -<drop>-> ONT: every strand of the cable is spliced. */
function joint(closureModel, cable) {
  return {
    name: 'Feeder joint',
    nodes: [
      { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'j1', type: 'closure', model: closureModel, name: 'Feeder joint' },
      { id: 'hh1', type: 'closure', model: 'handhole-4', name: 'Handhole' },
      { id: 'ont1', type: 'ont', model: 'gpon-ont-1ge', name: 'Casa 1' }
    ],
    spans: [
      { id: 's1', from: 'olt1', to: 'j1', cable: cable, lengthM: 900 },
      { id: 's2', from: 'j1', to: 'hh1', cable: cable, lengthM: 400 },
      { id: 'sd', from: 'hh1', to: 'ont1', cable: 'g657a2-drop-1', lengthM: 40 }
    ]
  };
}

test('a 144F through-joint in it produces no capacity note', function () {
  const r = network.designForOnt(joint('fosc-600c-inline-216', 'g652d-loose-144'), 'ont1', registry);
  // 144 strands through 216 positions: 144 <= 216, so engine/network.js is silent.
  assert.deepStrictEqual(r.notes, []);
});

test('a 96F through-joint in it produces no capacity note', function () {
  const r = network.designForOnt(joint('fosc-600c-inline-216', 'g652d-loose-96'), 'ont1', registry);
  assert.deepStrictEqual(r.notes, []);
});

test('the mufa still names the same joint, with both numbers - the hole was real', function () {
  const r = network.designForOnt(joint('mufa-inline-24', 'g652d-loose-144'), 'ont1', registry);
  assert.strictEqual(r.notes.length, 1, 'one note for the over-stuffed box: ' + JSON.stringify(r.notes));
  assert.ok(r.notes[0].indexOf('144 splices') !== -1, 'counts the strands: ' + r.notes[0]);
  assert.ok(r.notes[0].indexOf('capacity 24') !== -1, 'states the capacity: ' + r.notes[0]);
});

test('a 288F ribbon trunk is still refused by this row and taken by the 600-D', function () {
  // 288 > 216, so the model's strand count refuses it by name - the row must not absorb the trunk.
  const here = network.designForOnt(joint('fosc-600c-inline-216', 'g652d-ribbon-288'), 'ont1', registry);
  assert.strictEqual(here.notes.length, 1, JSON.stringify(here.notes));
  assert.ok(here.notes[0].indexOf('288 splices') !== -1, here.notes[0]);
  assert.ok(here.notes[0].indexOf('capacity 216') !== -1, here.notes[0]);
  // 288 <= 504: the 288F box the catalogue already had still joints it.
  const trunk = network.designForOnt(joint('fosc-600d-inline-504', 'g652d-ribbon-288'), 'ont1', registry);
  assert.deepStrictEqual(trunk.notes, []);
});

done();
