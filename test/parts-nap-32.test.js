'use strict';
// The NAP family ran 8, 12, 16 and 24 drop adapters and stopped, so the largest box in the catalogue
// took 26 cables. Thirty-two drops is not an exotic site - it is one 1:32 splitter's worth of
// customers, and 32 is a ratio in engine/design.js's own DEFAULTS.pon.ratios. Measured on main at
// 3c92a08, `design.synthesise` on 32 houses bound to 32 streets with `pon.ratios: [32]` ranks the PON
// feasible and buys a `nap-24` where the 32 drop cables converge, and `network.validate` then reports
// `closure "..." has 32 cables into 26 ports` - six drops with nowhere to land, on a plant the tool
// designed itself. Nothing in the engine nudges a NAP size (CLOSURE_LADDER is nap-8/16/24), so this
// row is the one a hand-drawn 32-drop site or a bare 1:32 splitter site names, exactly as nap-12 was
// for twelve.
//
// These assertions hold `ports` to the rule the engine checks - drop adapters PLUS the feeder entry -
// and drive the load that makes the row worth having, plus the load the old ceiling could not carry.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const NAP = 'nap-32';
const DROP_PORTS = 32;

test('the 32-drop NAP is 32 adapters plus the feeder entry, and 48 splices', function () {
  const c = registry.get('closure', NAP);
  assert.strictEqual(c.type, 'nap');
  // Whyte WFDB-CAS-32 prints '32 Way' and 48 splice capacity; Altice CRO 34SC/APC adds the two inputs
  // a splitter inside the box spends, and this row carries the one feeder a NAP is fed by. 32 + 1 = 33.
  assert.strictEqual(c.ports, DROP_PORTS + 1, '33 cable ports: 32 drops + 1 feeder');
  // 48 holds the 33 fusions a full load makes - feeder through, 32 drops on pigtails - with 15 spare.
  assert.strictEqual(c.spliceCapacity, 48);
  assert.ok(c.spliceCapacity >= DROP_PORTS + 1, 'a full box must have a splice position per drop plus its feeder');
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

test('a full 32-drop site puts exactly 33 cables on the box and draws no warning', function () {
  // 32 drops + 1 feeder = 33 cables into 33 ports: silent, which is the reason the row exists. Errors
  // are checked too, so this cannot pass on a model the registry cannot even name.
  const r = engine.network.validate(load(NAP, DROP_PORTS), registry);
  assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));
  assert.deepStrictEqual(r.warnings, [], JSON.stringify(r.warnings));
  assert.strictEqual(r.ok, true);
});

test('a 33rd drop is over-ported by name, not silently absorbed', function () {
  const w = portWarnings(load(NAP, DROP_PORTS + 1));
  // 33 + 1 = 34 cables into 33 ports: one warning, and it states both numbers.
  assert.strictEqual(w.length, 1, JSON.stringify(w));
  assert.ok(w[0].indexOf('34 cables into 33 ports') !== -1, w[0]);
});

test('the 24-port box, the catalogue ceiling before this row, is over-ported at 32 drops', function () {
  // 32 drops + 1 feeder = 33 cables into nap-24's 26 ports. This is the state the row is added to
  // fix: a 32-drop site had no box that could take its cables, and the design still bought one.
  const w = portWarnings(load('nap-24', DROP_PORTS));
  assert.strictEqual(w.length, 1, JSON.stringify(w));
  assert.ok(w[0].indexOf('33 cables into 26 ports') !== -1, w[0]);
  assert.strictEqual(portWarnings(load(NAP, DROP_PORTS)).length, 0, 'the same load on nap-32 is silent');
});

done();
