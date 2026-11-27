'use strict';
// A span is one route, not always one cable: `bundles` is how many whole cables run it (SPEC §5).
// A closure is where those cables physically arrive, so both numbers it publishes - its `ports`
// (cables) and its `spliceCapacity` (fibres) - must count every cable in the bundle. Counting spans
// read a 2 x 12 feeder as one 12-fibre cable: 24 fibres passed a 12-splice handhole and the budget
// reported the box at exactly its capacity, and six cables entered a 4-port box with no warning.
// The port warning's own sentence says "N cables into M ports", so a span count is also a lie in the
// words the planner reads.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const network = engine.network;

function strands(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(i);
  return out;
}

test('a 2 x 12 feeder holds 24 splices in a 12-splice handhole and is named', function () {
  // OLT -2x12- Handhole 1 -2x12- Handhole 2 -drop- ONT.
  // Handhole 1 joins 24 fibres to 24 fibres: 24 splices against a capacity of 12.
  // Handhole 2 joins the 24-fibre bundle to one drop strand: one splice, so it is not named.
  const plant = {
    name: 'Bundled feeder',
    nodes: [
      { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'hh1', type: 'closure', model: 'handhole-4', name: 'Handhole 1' },
      { id: 'hh2', type: 'closure', model: 'handhole-4', name: 'Handhole 2' },
      { id: 'ont1', type: 'ont', model: 'gpon-ont-1ge', name: 'Casa 1' }
    ],
    spans: [
      { id: 's1', from: 'olt1', to: 'hh1', cable: 'g652d-loose-12', lengthM: 100, bundles: 2, strands: strands(24) },
      { id: 's2', from: 'hh1', to: 'hh2', cable: 'g652d-loose-12', lengthM: 100, bundles: 2, strands: strands(24) },
      { id: 'sd', from: 'hh2', to: 'ont1', cable: 'g657a2-drop-1', lengthM: 20, strands: [1] }
    ]
  };
  const r = network.designForOnt(plant, 'ont1', registry);
  assert.strictEqual(r.notes.length, 1, 'one over-stuffed box: ' + JSON.stringify(r.notes));
  assert.ok(r.notes[0].indexOf('"Handhole 1"') !== -1, 'names the first box: ' + r.notes[0]);
  assert.ok(r.notes[0].indexOf('24 splices') !== -1, 'counts every cable in the bundle: ' + r.notes[0]);
  assert.ok(r.notes[0].indexOf('capacity 12') !== -1, 'states the capacity: ' + r.notes[0]);
  // The box's cable count is right too: two bundled spans into Handhole 1 is four cables into four
  // ports, and Handhole 2 takes three cables, so neither draws a port warning.
  assert.deepStrictEqual(network.validate(plant, registry).warnings, []);
});

test('six cables in a bundle are six cables into a four-port box', function () {
  // Three bundled spans plus the feed into Handhole 1: 4 spans x 2 cables = 8 cables into 4 ports.
  // The four-port handhole elsewhere on each branch takes two cables and stays silent.
  const plant = {
    name: 'Bundled junction',
    nodes: [
      { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'hh1', type: 'closure', model: 'handhole-4', name: 'Handhole 1' },
      { id: 'c1', type: 'closure', model: 'handhole-4', name: 'C1' },
      { id: 'c2', type: 'closure', model: 'handhole-4', name: 'C2' },
      { id: 'c3', type: 'closure', model: 'handhole-4', name: 'C3' }
    ],
    spans: [
      { id: 'a', from: 'olt1', to: 'hh1', cable: 'g652d-loose-12', lengthM: 10, bundles: 2, strands: [1, 2] },
      { id: 'b', from: 'hh1', to: 'c1', cable: 'g652d-loose-12', lengthM: 10, bundles: 2, strands: [1, 2] },
      { id: 'c', from: 'hh1', to: 'c2', cable: 'g652d-loose-12', lengthM: 10, bundles: 2, strands: [1, 2] },
      { id: 'd', from: 'hh1', to: 'c3', cable: 'g652d-loose-12', lengthM: 10, bundles: 2, strands: [1, 2] }
    ]
  };
  const w = network.validate(plant, registry).warnings.filter(function (line) {
    return line.indexOf('cables into') !== -1;
  });
  assert.strictEqual(w.length, 1, 'one over-ported box: ' + JSON.stringify(network.validate(plant, registry).warnings));
  assert.ok(w[0].indexOf('"Handhole 1"') !== -1, 'names the box: ' + w[0]);
  assert.ok(w[0].indexOf('8 cables into 4 ports') !== -1, 'counts cables, not spans: ' + w[0]);
});

done();
