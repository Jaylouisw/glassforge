'use strict';
// The in-line ladder was 48 / 96 / 144 / 216 / 504 splices, and the catalogue sells a 288-fibre ribbon
// trunk (g652d-ribbon-288). A through-joint splices every strand the cable carries, so a 288F trunk in
// the 216 row read "would carry 288 splices, capacity 216" and engine/link.js could only answer with
// fosc-600d-inline-504 - a 254 mm-high trunk dome with 216 unused seats for a joint that fits the 152 mm
// housing. The 600 C ordered with 96-way D trays is 3 x 96 = 288 splices in that same housing
// (CommScope PS-322662-EU (01/16), 'Dimensions and capacities'), so the joint has its own rung. This
// suite holds the row to the sheet's figures and to the two engine behaviours it exists for.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const network = engine.network;
const link = engine.link;

test('the FOSC 600-C 288 row is 3 D trays of 96 splices in the 152 mm-high housing', function () {
  const c = registry.get('closure', 'fosc-600c-inline-288');
  // CommScope FOSC-600 data sheet PS-322662-EU (01/16): 600 C is 828 mm long, 152 mm high, 274 mm
  // wide; in-line single element splicing is 288 fibres in 3 trays; the ordering table's tray codes are
  // 36, 72, S96/L96 (96 SMOUV protectors) and A72/A96 (ANT). 3 x 96 = 288.
  assert.strictEqual(c.type, 'inline');
  assert.strictEqual(c.spliceCapacity, 288, '3 trays x 96 splices');
  assert.strictEqual(c.trays, 3, '288 / 96 per tray');
  // ports counts CABLES: one 4-port gel block is the order code 4, the same field the 216 and 504 rows
  // carry, and PARTS.md asks this field for the cables the box takes rather than its adapter count.
  assert.strictEqual(c.ports, 4, 'one 4-port gel block, as on the 600-C at 216');
  assert.strictEqual(c.vendor, 'CommScope');
  assert.ok(c.sourceUrl && c.sourceUrl.length > 0, 'a closure row that sizes a joint names its source');
  assert.ok(c.notes.indexOf('72-way order') !== -1,
    'the notes must say a 72-way tray order is not 288 splices');
  assert.ok(c.notes.indexOf('replace') !== -1, 'the notes must carry the replaced-by-the-purchased-part caveat');
});

test('it is the smallest in-line closure that seats a 288F joint, and the 216 row still refuses one', function () {
  const inlines = registry.all('closure').filter(function (x) { return x.type === 'inline'; });
  const fits = inlines.filter(function (x) { return x.spliceCapacity >= 288; })
    .sort(function (a, b) { return a.spliceCapacity - b.spliceCapacity || (a.model < b.model ? -1 : 1); });
  assert.ok(fits.length >= 1, 'no in-line closure holds 288 splices');
  // Before this row the smallest box at or above 288 was the 504-seat 600 D (254 mm high).
  assert.strictEqual(fits[0].model, 'fosc-600c-inline-288', 'smallest fitting in-line closure: ' + fits[0].model);
  assert.strictEqual(fits[0].spliceCapacity, 288, '288 is the first capacity at or above 288');
  // The 72-way order of the same housing is unchanged: 288 strands in 216 positions is still a note.
  assert.ok(registry.get('closure', 'fosc-600c-inline-216').spliceCapacity < 288,
    'the 216 row must not absorb the 288F trunk');
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

test('a 288F ribbon trunk through this row sits exactly at capacity and raises nothing', function () {
  const r = network.designForOnt(joint('fosc-600c-inline-288', 'g652d-ribbon-288'), 'ont1', registry);
  // 288 strands through 288 positions: engine/network.js checks inThisClosure > spliceCapacity, so
  // equal is quiet - the joint is the size of the box.
  assert.deepStrictEqual(r.notes, []);
});

test('the same trunk in the 216 row reads one note - the hole was real', function () {
  const r = network.designForOnt(joint('fosc-600c-inline-216', 'g652d-ribbon-288'), 'ont1', registry);
  assert.strictEqual(r.notes.length, 1, JSON.stringify(r.notes));
  assert.ok(r.notes[0].indexOf('288 splices') !== -1, r.notes[0]);
  assert.ok(r.notes[0].indexOf('capacity 216') !== -1, r.notes[0]);
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

test('engine/link.js names this box first for a 288-splice joint, ahead of the 504', function () {
  const r = link.design({ sites: { a: A, b: B }, network: figureOfEight(), optics: ER, fibres: 288,
    cable: 'g652d-ribbon-288' }, registry);
  const warning = r.warnings.filter(function (w) { return w.indexOf('would carry 288 splices') !== -1; });
  assert.strictEqual(warning.length, 1, r.warnings.join(' | '));
  // The fits list is ascending by capacity: 288, 504. Before this row the only named box was the
  // 504-seat trunk dome; a 288F joint now reads the 152 mm housing's own tray order first.
  const named = warning[0].slice(warning[0].indexOf('inline closures that would:'));
  assert.ok(named.indexOf('fosc-600c-inline-288 (288)') !== -1, 'must name the 288-splice box: ' + warning[0]);
  assert.ok(named.indexOf('fosc-600c-inline-288') < named.indexOf('fosc-600d-inline-504'),
    'the smallest fitting box is named first: ' + named);
});

done();
