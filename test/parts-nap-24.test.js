'use strict';
// The NAP family stopped at sixteen drops, so a 17-24 way site had no box: two nap-16s with a
// feeder span and a joint between them, or `mufa-inline-24` - the closure engine/design.js falls back
// to above degree 16, which is a 24-splice butt joint with no drop adapters at all. These assertions
// hold the row to the COMtec FDB-2-24A sheet (24 SC adapters, up to 48 fusions, two cable entries) and
// hold `ports` to the rule the engine actually checks: cabling into the box, adapters plus entries.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const NAP = 'nap-24';
const DROP_PORTS = 24;
const FEEDER_ENTRIES = 2;

test('the 24-drop NAP is 24 adapters plus two feeder entries, and 48 splices', function () {
  const c = registry.get('closure', NAP);
  assert.strictEqual(c.type, 'nap');
  // COMtec CM-ODF-FDB-24: "terminates up to 2 fiber optic cables ... up to 48 fusions, allocates 24
  // SC adapters ... up to 24 simplex [exit] cables". 24 adapters + 2 entries = 26 cable ports.
  assert.strictEqual(c.ports, DROP_PORTS + FEEDER_ENTRIES, '26 cable ports: 24 drops + 2 feeders');
  assert.strictEqual(c.spliceCapacity, 48, 'the sheet publishes 48 fusions');
  assert.strictEqual(c.trays, 2, 'the double-layer body: splitter/slack layer and splice layer');
});

test('it is the largest NAP the catalogue holds - 24 drops had no box before it', function () {
  const naps = registry.all('closure').filter(function (c) { return c.type === 'nap'; })
    .sort(function (a, b) { return b.ports - a.ports || (a.model < b.model ? -1 : 1); });
  assert.strictEqual(naps[0].model, NAP, 'largest nap by cable ports: ' + naps[0].model);
  // The sibling is 17 ports (16 drops + one entry); before this row the next size up was a joint.
  assert.strictEqual(naps[1].model, 'nap-16');
  assert.strictEqual(naps[1].ports, 17);
});

/**
 * OLT -<feeder>-> NAP -<feeder>-> NAP -<drop x n>-> ONTs: a cascaded site, which spends BOTH feeder
 * entries and every drop adapter, so it is the plant that puts the most cables on the box.
 */
function cascadedNap(dropCount) {
  const nodes = [
    { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
    { id: 'nap1', type: 'closure', model: NAP, name: 'NAP 24' },
    { id: 'nap2', type: 'closure', model: 'nap-16', name: 'NAP 16' }
  ];
  const spans = [
    { id: 's-in', from: 'olt1', to: 'nap1', cable: 'g652d-loose-12', lengthM: 800 },
    { id: 's-out', from: 'nap1', to: 'nap2', cable: 'g652d-loose-12', lengthM: 200 }
  ];
  for (let i = 1; i <= dropCount; i++) {
    const id = 'ont' + i;
    nodes.push({ id: id, type: 'ont', model: 'gpon-ont-1ge', name: 'Casa ' + i });
    spans.push({ id: 'd' + i, from: 'nap1', to: id, cable: 'g657a2-drop-1', lengthM: 40 });
  }
  return { name: 'Cascaded NAP site', nodes: nodes, spans: spans };
}

test('a full 24-drop cascade puts exactly 26 cables on the box and draws no warning', function () {
  const r = engine.network.validate(cascadedNap(DROP_PORTS), registry);
  // 2 + 24 = 26 cables into 26 ports: silent, which is the whole point of the row.
  assert.deepStrictEqual(r.warnings, [], JSON.stringify(r.warnings));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('a 25th drop is over-ported by name, not silently absorbed', function () {
  const r = engine.network.validate(cascadedNap(DROP_PORTS + 1), registry);
  // 2 + 25 = 27 cables into 26 ports: one warning, and it states both numbers.
  assert.strictEqual(r.warnings.length, 1, JSON.stringify(r.warnings));
  assert.ok(r.warnings[0].indexOf('27 cables into 26 ports') !== -1, r.warnings[0]);
});

test('the same 24-drop plant is over-ported on nap-16 - the hole was real', function () {
  const plant = cascadedNap(DROP_PORTS);
  plant.nodes[1].model = 'nap-16';
  const r = engine.network.validate(plant, registry);
  // nap-16 takes 17 cables and this site runs 26 through it: 9 cables past the box.
  assert.strictEqual(r.warnings.length, 1, JSON.stringify(r.warnings));
  assert.ok(r.warnings[0].indexOf('26 cables into 17 ports') !== -1, r.warnings[0]);
});

done();
