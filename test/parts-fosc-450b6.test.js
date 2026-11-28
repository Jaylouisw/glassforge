'use strict';
// The feeder ladder this catalogue sells is 48/72/96/144 fibre, and the in-line joints were 24
// (mufa-inline-24), 48 (fosc-400a4-inline-48), 96 (fosc-400b4-inline-96), 216 (fosc-600c-inline-216)
// and 504 (fosc-600d-inline-504). A through-joint splices every strand the cable carries, so the
// commonest joint there is - one 144F feeder cable spliced straight through - read "would carry 144
// splices, capacity 24" in the mufa and engine/link.js could only answer with a 216-splice box 32.6 in
// long (72 unused seats) or a 504. This suite holds the FOSC 450 B6 row to the guide's own numbers and
// to the two engine behaviours it exists for: it seats a 144F joint exactly, and it is named first.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const network = engine.network;
const link = engine.link;

test('the FOSC 450 B6 row is 6 trays of 24 splices on a 6-port multi-cable seal', function () {
  const c = registry.get('closure', 'fosc-450b6-inline-144');
  // CommScope FOSC 450 Product Ordering Guide, Sixth Edition, 'Closure Capacities and
  // Characteristics': 450 B6 single splice with SM12 modules = 144, with SM6 modules = 72, flat-matrix
  // ribbon 432. Six B-size trays: 6 x 24 = 144, 6 x 12 = 72, 6 x 72 mass splices = 432.
  assert.strictEqual(c.type, 'inline');
  assert.strictEqual(c.spliceCapacity, 144, '6 trays x 24 splices');
  assert.strictEqual(c.trays, 6, '144 / 24 per tray');
  // ports counts CABLES, not ports: the family page states 'up to 16 drop cables in addition to a
  // feed-through cable' = 17, and the six entry ports are multi-cable gel blocks (PARTS.md rule).
  assert.strictEqual(c.ports, 17, '16 drop cables + one feed-through');
  assert.strictEqual(c.vendor, 'CommScope');
  assert.ok(c.sourceUrl && c.sourceUrl.length > 0, 'a closure row that sizes a joint names its source');
});

test('it is the smallest in-line closure that seats a 144F joint', function () {
  const inlines = registry.all('closure').filter(function (x) { return x.type === 'inline'; });
  const fits = inlines.filter(function (x) { return x.spliceCapacity >= 144; })
    .sort(function (a, b) { return a.spliceCapacity - b.spliceCapacity || (a.model < b.model ? -1 : 1); });
  assert.ok(fits.length >= 1, 'no in-line closure holds 144 splices');
  // Before this row the smallest was 216, and a 144F joint bought 72 unused seats in a 32.6 in dome.
  assert.strictEqual(fits[0].model, 'fosc-450b6-inline-144', 'smallest fitting in-line closure: ' + fits[0].model);
  assert.strictEqual(fits[0].spliceCapacity, 144, '144 is the first capacity at or above 144');
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

test('a 144F through-joint sits exactly at this row capacity and raises nothing', function () {
  const r = network.designForOnt(joint('fosc-450b6-inline-144', 'g652d-loose-144'), 'ont1', registry);
  // 144 strands through 144 positions: engine/network.js checks inThisClosure > spliceCapacity, so
  // equal is quiet - the joint is the size of the box.
  assert.deepStrictEqual(r.notes, []);
});

test('the same 144F joint in the mufa reads one note - the hole was real', function () {
  const r = network.designForOnt(joint('mufa-inline-24', 'g652d-loose-144'), 'ont1', registry);
  assert.strictEqual(r.notes.length, 1, JSON.stringify(r.notes));
  assert.ok(r.notes[0].indexOf('144 splices') !== -1, r.notes[0]);
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

test('engine/link.js names this box first for a 144-splice joint, ahead of the 216', function () {
  const r = link.design({ sites: { a: A, b: B }, network: figureOfEight(), optics: ER, fibres: 144 }, registry);
  const warning = r.warnings.filter(function (w) { return w.indexOf('would carry 144 splices') !== -1; });
  assert.strictEqual(warning.length, 1, r.warnings.join(' | '));
  // The fits list is ascending by capacity: 144, 216, 504. Before this row the first named was the
  // 216-splice trunk box; a 144F joint now reads its own box first.
  const named = warning[0].slice(warning[0].indexOf('inline closures that would:'));
  assert.ok(named.indexOf('fosc-450b6-inline-144 (144)') !== -1, 'must name the 144-splice box: ' + warning[0]);
  assert.ok(named.indexOf('fosc-450b6-inline-144') < named.indexOf('fosc-600c-inline-216'),
    'the smallest fitting box is named first: ' + named);
});

done();
