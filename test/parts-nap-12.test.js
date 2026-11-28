'use strict';
// The NAP family shipped 8, 16 and 24 drop adapters, so the twelve-way box a street site or a small
// MDU is actually ordered in had no row: a 12-drop site was either bought as a 16 (two adapters and a
// tray paid for and never used) or planned on an 8 and refused by name - `network.validate` counts the
// cables into the box, and 12 drops + 1 feeder is 13 into 9. Nothing in the engine nudges a NAP size
// (engine/design.js's CLOSURE_LADDER is nap-8/16/24 and picks by port count), so this row is the one a
// manual design names, exactly as the 36F and 60F duct rungs are the rungs a custom ladder names.
// These assertions hold `ports` to the rule the engine checks - drop adapters PLUS the feeder entry -
// and drive the two loads that make the row worth having.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const NAP = 'nap-12';
const DROP_PORTS = 12;

test('the 12-drop NAP is 12 adapters plus the feeder entry, and 48 splices', function () {
  const c = registry.get('closure', NAP);
  assert.strictEqual(c.type, 'nap');
  // Amphenol Charles FSDC12P: "12 drop ports and an internal bulkhead with 12 SC/APC adapters", and
  // NetSpan's PRO10 publishes 12 standard SC/APC drop ports. 12 adapters + 1 feeder entry = 13.
  assert.strictEqual(c.ports, DROP_PORTS + 1, '13 cable ports: 12 drops + 1 feeder');
  // The class spans 24 fusions (NetSpan PRO10's NSST2448E tray) to 144 (FSDC12P's 3 x 48 trays), so 48
  // is the mid-size figure this row budgets: 12 drops spliced onto a 12F feeder is 24 of the 48.
  assert.strictEqual(c.spliceCapacity, 48);
  assert.strictEqual(c.trays, 4);
});

/** One feeder into a closure, then `drops` single-fibre drop cables out to as many ONTs. */
function load(model, drops) {
  const nodes = [
    { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
    { id: 'n1', type: 'closure', model: model, name: 'NAP' }
  ];
  const spans = [{ id: 's0', from: 'olt1', to: 'n1', cable: 'g652d-loose-12', lengthM: 300 }];
  for (let i = 1; i <= drops; i++) {
    nodes.push({ id: 'ont' + i, type: 'ont', model: 'gpon-ont-1ge', name: 'Casa ' + i });
    spans.push({ id: 'sd' + i, from: 'n1', to: 'ont' + i, cable: 'g657a2-drop-1', lengthM: 40 });
  }
  return { name: 'NAP load', nodes: nodes, spans: spans };
}

function portWarnings(plant) {
  return engine.network.validate(plant, registry).warnings.filter(function (w) {
    return w.indexOf('cables into') !== -1;
  });
}

test('a full 12-drop site puts exactly 13 cables on the box and draws no warning', function () {
  // 12 drops + 1 feeder = 13 cables into 13 ports: silent, which is the reason the row exists. The
  // errors are checked too, so this cannot pass on a model the registry cannot even name.
  const r = engine.network.validate(load(NAP, DROP_PORTS), registry);
  assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));
  assert.deepStrictEqual(r.warnings, [], JSON.stringify(r.warnings));
  assert.strictEqual(r.ok, true);
});

test('a 13th drop is over-ported by name, not silently absorbed', function () {
  const w = portWarnings(load(NAP, DROP_PORTS + 1));
  // 13 + 1 = 14 cables into 13 ports: one warning, and it states both numbers.
  assert.strictEqual(w.length, 1, JSON.stringify(w));
  assert.ok(w[0].indexOf('14 cables into 13 ports') !== -1, w[0]);
});

test('the same 12-drop site is over-ported on nap-8 - the hole was real', function () {
  // 12 + 1 = 13 cables into nap-8's 9 ports: four drops past the box.
  const w = portWarnings(load('nap-8', DROP_PORTS));
  assert.strictEqual(w.length, 1, JSON.stringify(w));
  assert.ok(w[0].indexOf('13 cables into 9 ports') !== -1, w[0]);
});

test('nap-12 sits between nap-8 and nap-16 in the ladder by cable ports', function () {
  const ports = {};
  for (const model of ['nap-8', NAP, 'nap-16', 'nap-24']) ports[model] = registry.get('closure', model).ports;
  // 9 < 13 < 17 < 26: one size up is a 16, one size down an 8.
  assert.ok(ports['nap-8'] < ports[NAP], 'nap-8 ' + ports['nap-8'] + ' vs nap-12 ' + ports[NAP]);
  assert.ok(ports[NAP] < ports['nap-16'], 'nap-12 ' + ports[NAP] + ' vs nap-16 ' + ports['nap-16']);
});

done();
