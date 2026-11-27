'use strict';
// The catalogue sold 48-, 72- and 96-fibre feeder cable but its in-line joints were 24 splices
// (mufa-inline-24), 216 (fosc-600c-inline-216) and 504 (fosc-600d-inline-504). A 48F through-joint
// therefore read "would carry 48 splices, capacity 24" in the mufa, and engine/link.js answered with
// the 216-splice trunk box - a closure built for a 144F cable. The FOSC 400-B4 is the 96-splice joint
// between them: one rung, the same story as the 600-C row one size up. This suite holds it to the
// trays it is ordered with, to the size it claims to be the smallest for, and to the warning a
// 48-splice joint now reads.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const network = engine.network;
const link = engine.link;

test('the FOSC 400-B4 row is 4 trays of 24 splices on 6 cable entries', function () {
  const c = registry.get('closure', 'fosc-400b4-inline-96');
  // CommScope PS-319073.2-EU (12/15), Dimensions and Capacities: B4 = 540 mm, 4 round ports
  // (5-19 mm) + one oval port for 2 cables (10-25 mm) = 6 cables; trays 4/6 with single-fibre
  // splicing capacity 96/144. 4 x 24 = 96 is the four-tray order this row carries.
  assert.strictEqual(c.type, 'inline');
  assert.strictEqual(c.spliceCapacity, 96, '4 trays x 24 splices');
  assert.strictEqual(c.trays, 4);
  assert.strictEqual(c.ports, 6, 'one oval port for 2 cables plus 4 round ports');
  assert.ok(c.sourceUrl && c.sourceUrl.length > 0, 'a closure row that sizes a joint names its source');
});

test('it is the smallest in-line closure that joints a 96F cable', function () {
  const inlines = registry.all('closure').filter(function (c) { return c.type === 'inline'; });
  const fits = inlines.filter(function (c) { return c.spliceCapacity >= 96; })
    .sort(function (a, b) { return a.spliceCapacity - b.spliceCapacity || (a.model < b.model ? -1 : 1); });
  assert.ok(fits.length >= 1, 'no in-line closure holds 96 splices');
  // Before this row the smallest was 216: a 96F joint bought a closure sized for a 144F cable.
  assert.strictEqual(fits[0].model, 'fosc-400b4-inline-96', 'smallest fitting in-line closure: ' + fits[0].model);
  assert.strictEqual(fits[0].spliceCapacity, 96, '96 is the first capacity at or above 96');
});

test('a 144F joint still goes to the 600-C, so this row does not absorb the next size up', function () {
  const inlines = registry.all('closure').filter(function (c) { return c.type === 'inline'; });
  const fits = inlines.filter(function (c) { return c.spliceCapacity >= 144; })
    .sort(function (a, b) { return a.spliceCapacity - b.spliceCapacity || (a.model < b.model ? -1 : 1); });
  // 96 < 144, so fosc-400b4-inline-96 is not in this list and the 216 stays the answer.
  assert.strictEqual(fits[0].model, 'fosc-600c-inline-216', 'smallest fitting in-line closure: ' + fits[0].model);
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

test('a 96F through-joint sits exactly at this row capacity and raises nothing', function () {
  const r = network.designForOnt(joint('fosc-400b4-inline-96', 'g652d-loose-96'), 'ont1', registry);
  // 96 strands through 96 positions: engine/network.js checks inThisClosure > spliceCapacity, so
  // equal is quiet - the joint is the size of the box, which is what "the smallest that fits" means.
  assert.deepStrictEqual(r.notes, []);
});

test('the mufa still names the same 96F joint, with both numbers - the hole was real', function () {
  const r = network.designForOnt(joint('mufa-inline-24', 'g652d-loose-96'), 'ont1', registry);
  assert.strictEqual(r.notes.length, 1, JSON.stringify(r.notes));
  assert.ok(r.notes[0].indexOf('96 splices') !== -1, r.notes[0]);
  assert.ok(r.notes[0].indexOf('capacity 24') !== -1, r.notes[0]);
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

test('a 48-splice joint is now offered this box before the 216-splice trunk closure', function () {
  const r = link.design({ sites: { a: A, b: B }, network: figureOfEight(), optics: ER, fibres: 48 }, registry);
  const warning = r.warnings.filter(function (w) { return w.indexOf('would carry 48 splices') !== -1; });
  assert.strictEqual(warning.length, 1, r.warnings.join(' | '));
  // The fits list is ascending by capacity: 48, 96, 216, 504. Before the B4 row the first named was
  // 216; fosc-400a4-inline-48 is now the smallest answer to a 48-splice joint, and this row is still
  // named ahead of the 216-splice trunk box.
  const named = warning[0].slice(warning[0].indexOf('inline closures that would:'));
  assert.ok(named.indexOf('fosc-400b4-inline-96 (96)') !== -1, 'must name the 96-splice box: ' + warning[0]);
  assert.ok(named.indexOf('fosc-400b4-inline-96') < named.indexOf('fosc-600c-inline-216'),
    'the smallest fitting box is named first: ' + named);
});

done();
