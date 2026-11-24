'use strict';
// The catalogue sells feeder cable up to 288 fibres (g652d-ribbon-288, added before any box could
// joint it). Every closure here held 48 splices or fewer, so engine/network.js's capacity check -
// which compares the strands passing through a box against that box's spliceCapacity - reported a
// 288-fibre joint as over-stuffed by 240 splices, in every box the designer can choose. A cable no
// closure can joint is a cable the BOM cannot buy, so this suite holds the catalogue to the rule:
// every cable sold has at least one closure that can hold the splices of a through-joint in it.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const network = engine.network;

test('every cable in the catalogue can be jointed in a closure the catalogue sells', function () {
  const cables = registry.all('cable');
  const closures = registry.all('closure');
  // 504 is the FOSC 600-D in-line figure: 7 D trays x 72 splices. The assertion is the invariant,
  // not the number, so a bigger cable or a smaller box is what makes it fail.
  const biggest = closures.reduce(function (max, c) {
    return c.spliceCapacity > max ? c.spliceCapacity : max;
  }, 0);
  for (const cable of cables) {
    const fits = closures.filter(function (c) { return c.spliceCapacity >= cable.fiberCount; });
    assert.ok(fits.length > 0,
      cable.model + ' carries ' + cable.fiberCount + ' fibres, and the largest closure holds ' + biggest + ' splices');
  }
});

/** OLT -<288F>-> joint box -<288F>-> handhole -<drop>-> ONT. The joint box holds 288 through-splices. */
function joint(closureModel) {
  return {
    name: 'Feeder joint',
    nodes: [
      { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'j1', type: 'closure', model: closureModel, name: 'Feeder joint' },
      { id: 'hh1', type: 'closure', model: 'handhole-4', name: 'Handhole' },
      { id: 'ont1', type: 'ont', model: 'gpon-ont-1ge', name: 'Casa 1' }
    ],
    spans: [
      { id: 's1', from: 'olt1', to: 'j1', cable: 'g652d-ribbon-288', lengthM: 900 },
      { id: 's2', from: 'j1', to: 'hh1', cable: 'g652d-ribbon-288', lengthM: 400 },
      { id: 'sd', from: 'hh1', to: 'ont1', cable: 'g657a2-drop-1', lengthM: 40 }
    ]
  };
}

test('a 288-fibre through-joint in the 504-splice closure produces no capacity note', function () {
  const r = network.designForOnt(joint('fosc-600d-inline-504'), 'ont1', registry);
  assert.deepStrictEqual(r.notes, []);
});

test('the same joint in the 24-splice mufa is named, with both numbers', function () {
  // The contrast that makes the test above meaningful: the check is live, and 288 against 24 is the
  // warning a designer reads today. handhole-4 downstream holds one splice (the drop), so it is quiet.
  const r = network.designForOnt(joint('mufa-inline-24'), 'ont1', registry);
  assert.strictEqual(r.notes.length, 1, 'one note for the over-stuffed box: ' + JSON.stringify(r.notes));
  assert.ok(r.notes[0].indexOf('288 splices') !== -1, 'counts the splices: ' + r.notes[0]);
  assert.ok(r.notes[0].indexOf('capacity 24') !== -1, 'states the capacity: ' + r.notes[0]);
  assert.ok(r.notes[0].indexOf('"Feeder joint"') !== -1, 'names the box: ' + r.notes[0]);
});

done();
