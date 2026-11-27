'use strict';
// The catalogue sold 1:32 cassettes and had no box to put one in: splitter-box-16 takes 17 cables,
// and a 32-drop site is a feeder plus 32 drops = 33. A default PON design is built at ratio 32
// (engine/design.js DEFAULTS.pon.ratios = [8, 16, 32]), so the hole sat under the design the engine
// itself prefers. These assertions hold the new row to the Charles FCH32 data sheet - 36 SC/APC
// adapters (4 feed / 32 distribution), three trays of 24 splices - and hold `ports` to the rule the
// engine checks: the number of CABLES the enclosure terminates, adapters plus adapters, not drops
// plus grommets.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const HUB = 'fch32-compact-hub';
const FEED_PORTS = 4;
const DROP_PORTS = 32;

/** OLT -<feeders>-> hub -<drops>-> ONTs. One feeder in the ordinary case; more only to load ports. */
function site(model, drops, feeders) {
  const nodes = [
    { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
    { id: 'hub', type: 'closure', model: model, name: 'Hub' }
  ];
  const spans = [];
  for (let f = 1; f <= (feeders || 1); f++) {
    spans.push({ id: 'f' + f, from: 'olt1', to: 'hub', cable: 'g652d-loose-12', lengthM: 300 + f });
  }
  for (let i = 1; i <= drops; i++) {
    nodes.push({ id: 'ont' + i, type: 'ont', model: 'gpon-ont-1ge', name: 'Casa ' + i });
    spans.push({ id: 'd' + i, from: 'hub', to: 'ont' + i, cable: 'g657a2-drop-1', lengthM: 40 });
  }
  return { name: 'MDU hub', nodes: nodes, spans: spans };
}

function portWarnings(plant) {
  return engine.network.validate(plant, registry).warnings.filter(function (w) {
    return w.indexOf('cables into') !== -1;
  });
}

test('the 32-drop hub is 4 feed plus 32 distribution adapters and three 24-splice trays', function () {
  const c = registry.get('closure', HUB);
  assert.strictEqual(c.type, 'splitter-box', 'a cassette site presenting drop adapters');
  // The sheet: "36 SC/APC fiber adapters (4 feed / 32 distribution)"; one cable per adapter.
  assert.strictEqual(c.ports, FEED_PORTS + DROP_PORTS, '36 cable ports: 4 feed + 32 distribution');
  // "up to three small hinged splice trays", "each splice tray holds a maximum of 24 splices".
  assert.strictEqual(c.spliceCapacity, 3 * 24, '72 splices empty: 3 trays x 24');
  assert.strictEqual(c.trays, 3, 'three hinged trays');
});

test('a full 32-drop site fits the hub and draws no port warning', function () {
  // 1 feeder + 32 drops = 33 cables into 36 ports: three adapters spare.
  assert.deepStrictEqual(portWarnings(site(HUB, DROP_PORTS)), []);
  const r = engine.network.validate(site(HUB, DROP_PORTS), registry);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('the same 32-drop site is over-ported on splitter-box-16 - the hole was real', function () {
  const w = portWarnings(site('splitter-box-16', DROP_PORTS));
  // 1 + 32 = 33 cables into 17 ports: 16 cables past the box a 1:32 site was being drawn in.
  assert.strictEqual(w.length, 1, JSON.stringify(w));
  assert.ok(w[0].indexOf('33 cables into 17 ports') !== -1, w[0]);
});

test('the port count is the sheet cable capacity, and the boundary is 36', function () {
  // 5 feeders + 32 drops = 37 cables into 36 ports. Five feeders is not a hub a designer builds; the
  // plant only exists to cross the boundary, and its cycle warning is about the test, not the box.
  const w = portWarnings(site(HUB, DROP_PORTS, FEED_PORTS + 1));
  assert.strictEqual(w.length, 1, JSON.stringify(w));
  assert.ok(w[0].indexOf('37 cables into 36 ports') !== -1, w[0]);
  // 4 feeders + 32 drops = 36 cables: exactly full, silent.
  assert.deepStrictEqual(portWarnings(site(HUB, DROP_PORTS, FEED_PORTS)), []);
});

test('ports counts cables, so a 33rd drop passes the port check - the bulkhead is what stops it', function () {
  // 1 + 33 = 34 cables into 36 ports. The engine counts cables, not drops, so this is silent by
  // design; the 32 distribution adapters on the sheet are the real limit and the row's notes say so.
  assert.deepStrictEqual(portWarnings(site(HUB, DROP_PORTS + 1)), []);
});

test('it is the largest splitter box in the catalogue', function () {
  const boxes = registry.all('closure').filter(function (c) { return c.type === 'splitter-box'; })
    .sort(function (a, b) { return b.ports - a.ports || (a.model < b.model ? -1 : 1); });
  assert.strictEqual(boxes[0].model, HUB, 'largest splitter-box by cable ports: ' + boxes[0].model);
  // Before this row the family was one 16-drop box at 17 cable ports.
  assert.strictEqual(boxes[1].model, 'splitter-box-16');
  assert.strictEqual(boxes[1].ports, 17);
});

done();
