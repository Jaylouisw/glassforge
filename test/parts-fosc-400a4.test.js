'use strict';
// The in-line joint ladder was 24 splices (mufa-inline-24), then 96 (fosc-400b4-inline-96), then 216
// and 504. A joint of 25 to 48 splices - a 24F to 48F cable spliced straight through - therefore had
// no dome of its own: engine/link.js answered the mufa's over-capacity warning with the 96-splice B4,
// 48 positions and 120 mm of body nobody ordered, and engine/network.js read a 48F through-joint in
// the 24-splice mufa as over-stuffed. The FOSC 400-A4 is the rung between them, in the same published
// table as the B4 (48 splices at two trays, 5 cable entries). This suite holds it to that table and
// to the warnings a 48-splice joint now reads.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const network = engine.network;
const link = engine.link;

test('the FOSC 400-A4 row is 2 trays of 24 splices on 5 cable entries', function () {
  const c = registry.get('closure', 'fosc-400a4-inline-48');
  // CommScope PS-319073.2-EU (12/15), Dimensions and Capacities: A4 = 420 mm, 4 round ports
  // (5-19 mm) + one oval port for 2 cables (10-25 mm) = 5 cable entries; trays 2/3 with single-fibre
  // splicing capacity 48/72. 2 x 24 = 48 is the two-tray order this row carries.
  assert.strictEqual(c.type, 'inline');
  assert.strictEqual(c.spliceCapacity, 48, '2 trays x 24 splices');
  assert.strictEqual(c.trays, 2);
  assert.strictEqual(c.ports, 5, 'one oval port for 2 cables plus 4 round ports');
  assert.ok(c.sourceUrl && c.sourceUrl.length > 0, 'a closure row that sizes a joint names its source');
});

function inlineLadder(minSplices) {
  return registry.all('closure').filter(function (c) {
    return c.type === 'inline' || c.type === 'mufa';
  }).filter(function (c) {
    return c.spliceCapacity >= minSplices;
  }).sort(function (a, b) {
    return a.spliceCapacity - b.spliceCapacity || (a.model < b.model ? -1 : 1);
  });
}

test('it is the smallest in-line closure that joints a 48F cable', function () {
  const fits = inlineLadder(48);
  assert.ok(fits.length >= 1, 'no in-line closure holds 48 splices');
  // Before this row the smallest that held 48 was the 96-splice B4: twice the box for the joint.
  assert.strictEqual(fits[0].model, 'fosc-400a4-inline-48', 'smallest fitting in-line closure: ' + fits[0].model);
  assert.strictEqual(fits[0].spliceCapacity, 48, '48 is the first capacity at or above 48');
});

test('a 24-splice joint still stays in the 24-splice mufa, not the 48-fibre dome', function () {
  const fits = inlineLadder(24);
  // A4 is one rung up from the mufa, not a replacement for it: 24 fits at 24.
  assert.strictEqual(fits[0].model, 'mufa-inline-24', 'smallest fitting in-line closure: ' + fits[0].model);
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

test('a 48F through-joint sits exactly at this row capacity and raises nothing', function () {
  const r = network.designForOnt(joint('fosc-400a4-inline-48', 'g652d-loose-48'), 'ont1', registry);
  // 48 strands through 48 positions: engine/network.js checks inThisClosure > spliceCapacity, so
  // equal is quiet - the joint is the size of the box.
  assert.deepStrictEqual(r.notes, []);
});

test('the same 48F joint in the 24-splice mufa is named, with both numbers - the hole was real', function () {
  const r = network.designForOnt(joint('mufa-inline-24', 'g652d-loose-48'), 'ont1', registry);
  assert.strictEqual(r.notes.length, 1, JSON.stringify(r.notes));
  assert.ok(r.notes[0].indexOf('48 splices') !== -1, r.notes[0]);
  assert.ok(r.notes[0].indexOf('capacity 24') !== -1, r.notes[0]);
});

test('this row does not absorb the 96F joint: the B4 is still the smallest answer there', function () {
  const r = network.designForOnt(joint('fosc-400a4-inline-48', 'g652d-loose-96'), 'ont1', registry);
  assert.strictEqual(r.notes.length, 1, JSON.stringify(r.notes));
  assert.ok(r.notes[0].indexOf('96 splices') !== -1, r.notes[0]);
  assert.ok(r.notes[0].indexOf('capacity 48') !== -1, r.notes[0]);
  const fits = inlineLadder(96).filter(function (c) { return c.type === 'inline'; });
  assert.strictEqual(fits[0].model, 'fosc-400b4-inline-96', 'smallest fitting in-line closure: ' + fits[0].model);
});

function p(lat, lon) { return { lat: lat, lon: lon }; }

const A = { name: 'DC-West', lat: 51.5000, lon: -0.1020 };
const B = { name: 'DC-East', lat: 51.5000, lon: -0.0960 };
const M = p(51.5000, -0.0990);
const ER = { a: 'sfp-plus-10g-er-40km', b: 'sfp-plus-10g-er-40km' };

// Two edge-disjoint legs through one chamber M: one interior joint on each leg.
function figureOfEight() {
  return { edges: [
    { id: 'a-upper', coords: [p(51.5000, -0.1020), p(51.5005, -0.1010), M] },
    { id: 'a-lower', coords: [p(51.5000, -0.1020), p(51.4995, -0.1010), M] },
    { id: 'b-upper', coords: [M, p(51.5005, -0.0970), p(51.5000, -0.0960)] },
    { id: 'b-lower', coords: [M, p(51.4995, -0.0970), p(51.5000, -0.0960)] }
  ] };
}

test('a 48-splice joint is offered this 48-splice box first, not the 96', function () {
  const r = link.design({ sites: { a: A, b: B }, network: figureOfEight(), optics: ER, fibres: 48 }, registry);
  const warning = r.warnings.filter(function (w) { return w.indexOf('would carry 48 splices') !== -1; });
  assert.strictEqual(warning.length, 1, r.warnings.join(' | '));
  // The fits list is ascending by capacity: 48, 96, 216, 504.
  const named = warning[0].slice(warning[0].indexOf('inline closures that would:'));
  assert.ok(named.indexOf('fosc-400a4-inline-48 (48)') !== -1, 'must name the 48-splice box: ' + warning[0]);
  assert.ok(named.indexOf('fosc-400a4-inline-48') < named.indexOf('fosc-400b4-inline-96'),
    'the smallest fitting box is named first: ' + named);
});

done();
