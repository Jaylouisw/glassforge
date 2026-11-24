'use strict';
// A splitter has its own port count, and the plant check must read it.
//
// The OLT-level checks measure the deepest cascade and the total ONT count against `maxSplitRatio`;
// neither can see nine drops on a 1:8 cassette, because nine ONTs on one 1:8 site is a cascade of 8
// and 9 is far inside ports x ratio. Nine drops on an eight-port splitter is a design nobody can
// build, so it is a contradiction, not a warning (SPEC 1). The port count is the ratio: a 1x8 PLC
// has eight outputs.
//
// The unit is the FIBRE, not the cable. Ports used to be counted as cabled branches, which reported a
// splitter whose customers share one distribution cable (the shape auto-design emits) as "1 of 8", so
// the sentences below said "9 branches" where 9 was a count of customer fibres. Every topology in this
// file has one fibre per cable, so the numbers did not move - only the noun, and the cases at the end
// that a cable count could not see at all.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

/** OLT -> one splitter -> n independent drops, each with its own ONT. */
function fanout(n, opts) {
  const o = opts || {};
  const nodes = [
    { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lon: -0.1 },
    { id: 'sp1', type: 'splitter', model: o.splitter || 'plc-1x8-sca', name: 'SPL 1:8', lat: 51.501, lon: -0.1 }
  ];
  const spans = [{ id: 's1', from: 'olt1', to: 'sp1', cable: 'g652d-loose-12', lengthM: 900 }];
  for (let i = 1; i <= n; i++) {
    nodes.push({ id: 'ont' + i, type: 'ont', model: 'gpon-ont-4ge', name: 'Casa ' + i, lat: 51.5 + i * 0.0001, lon: -0.1 });
    spans.push({ id: 'd' + i, from: 'sp1', to: 'ont' + i, cable: 'g657a2-drop-1', lengthM: 40 });
  }
  return { nodes: nodes, spans: spans };
}

/**
 * OLT -> splitter -> ONE distribution cable carrying n customer fibres -> a closure -> n drops.
 *
 * This is the shape auto-design produces: a splitter site's customers share one cable out of the box,
 * one strand each, so the cassette's eight ports are eight strands in one span. `strands` here is the
 * planner's statement of which fibres are in use - a listed strand with no ONT behind it is spare, not
 * a customer.
 */
function sharedCable(n, opts) {
  const o = opts || {};
  const listed = o.listedFibres || n;
  const nodes = [
    { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lon: -0.1 },
    { id: 'sp1', type: 'splitter', model: 'plc-1x8-sca', name: 'SPL 1:8', lat: 51.501, lon: -0.1 },
    { id: 'c1', type: 'closure', model: 'nap-16', name: 'NAP 1', lat: 51.502, lon: -0.1 }
  ];
  const strands = [];
  for (let i = 1; i <= listed; i++) strands.push(i);
  const spans = [
    { id: 's1', from: 'olt1', to: 'sp1', cable: 'g652d-loose-12', lengthM: 900 },
    { id: 's2', from: 'sp1', to: 'c1', cable: 'g652d-loose-12', lengthM: 60, strands: strands }
  ];
  for (let i = 1; i <= n; i++) {
    nodes.push({ id: 'ont' + i, type: 'ont', model: 'gpon-ont-4ge', name: 'Casa ' + i, lat: 51.5021 + i * 0.0001, lon: -0.1 });
    spans.push({ id: 'd' + i, from: 'c1', to: 'ont' + i, cable: 'g657a2-drop-1', lengthM: 40, strands: [i] });
  }
  return { nodes: nodes, spans: spans };
}

/** OLT -> sp1 (1:8) -> sp2 (1:8) -> n drops: a legal cascade, whose ports are per site. */
function cascade(n) {
  const nodes = [
    { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lon: -0.1 },
    { id: 'sp1', type: 'splitter', model: 'plc-1x8-sca', name: 'SPL A', lat: 51.5005, lon: -0.1 },
    { id: 'sp2', type: 'splitter', model: 'plc-1x8-sca', name: 'SPL B', lat: 51.501, lon: -0.1 }
  ];
  const spans = [
    { id: 's1', from: 'olt1', to: 'sp1', cable: 'g652d-loose-12', lengthM: 500 },
    { id: 's2', from: 'sp1', to: 'sp2', cable: 'g652d-loose-12', lengthM: 100 }
  ];
  for (let i = 1; i <= n; i++) {
    nodes.push({ id: 'ont' + i, type: 'ont', model: 'gpon-ont-4ge', name: 'Casa ' + i, lat: 51.502 + i * 0.0001, lon: -0.1 });
    spans.push({ id: 'd' + i, from: 'sp2', to: 'ont' + i, cable: 'g657a2-drop-1', lengthM: 30 });
  }
  return { nodes: nodes, spans: spans };
}

test('eight drops on a 1x8 fill it exactly and validate', function () {
  // 8 branches on 8 ports: at capacity, not over it. The boundary is what makes the refusal below
  // arithmetic rather than a preference.
  const p = fanout(8);
  const v = engine.network.validate(p, registry);
  assert.deepStrictEqual(v.errors, [], 'eight branches fill an eight-port cassette');
  const cap = engine.network.capacity(p, registry);
  assert.deepStrictEqual(cap.problems, []);
  assert.strictEqual(cap.splitterPorts.length, 1, 'one splitter site reported');
  assert.strictEqual(cap.splitterPorts[0].portsUsed, 8, 'eight cabled outputs');
  assert.strictEqual(cap.splitterPorts[0].ratio, 8, 'the ratio is the port count');
  assert.strictEqual(cap.splitterPorts[0].overbooked, false);
});

test('a ninth drop on a 1x8 is refused by name, not counted as healthy capacity', function () {
  // 8 ports, 9 branches: a cascade of 8 (inside maxSplitRatio 64) and 9 ONTs (inside 8 x 64), so both
  // OLT-level checks pass. Only the splitter's own port count can refuse this plant.
  const p = fanout(9);
  const v = engine.network.validate(p, registry);
  assert.strictEqual(v.ok, false, 'nine drops on a 1:8 cannot be built');
  assert.strictEqual(v.errors.length, 1, 'one contradiction, got: ' + v.errors.join(' | '));
  assert.strictEqual(v.errors[0],
    'splitter "SPL 1:8" (sp1) has 9 fibres leaving it on 8 output ports (plc-1x8-sca) - 1 fibre has no port',
    'the refusal names the site, its label and id, the count and the part: ' + v.errors[0]);
  const cap = engine.network.capacity(p, registry);
  assert.strictEqual(cap.splitterCascade, 8, 'the cascade stays 8 - the OLT-level view is not what failed');
  assert.strictEqual(cap.splitterPorts[0].overbooked, true);
  assert.deepStrictEqual(cap.problems, [v.errors[0]], 'capacity reports the same sentence validate does');
});

test('a downstream splitter costs its parent one port, not one per ONT behind it', function () {
  // sp1 feeds sp2: one output in use at sp1 whatever sp2 fans out to. 8 drops behind sp2 fill sp2 and
  // leave sp1 at 1 of 8, so the plant is buildable - and the cascade is 8 x 8 = 64, which is exactly
  // the gpon-c-plus-8 limit, not over it.
  const p = cascade(8);
  const v = engine.network.validate(p, registry);
  assert.deepStrictEqual(v.errors, [], 'a full second splitter is still a legal cascade');
  const cap = engine.network.capacity(p, registry);
  assert.strictEqual(cap.splitterCascade, 64, '8 x 8 on the deepest path');
  const byNode = {};
  cap.splitterPorts.forEach(function (row) { byNode[row.node] = row; });
  assert.strictEqual(byNode.sp1.portsUsed, 1, 'one fibre: the span to sp2');
  assert.strictEqual(byNode.sp2.portsUsed, 8, 'eight customer fibres');
  assert.deepStrictEqual(cap.problems, []);
});

test('the overbooked site is the one named: nine behind sp2, sp1 untouched', function () {
  const p = cascade(9);
  const v = engine.network.validate(p, registry);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.errors.length, 1, 'only sp2 is over its ports: ' + v.errors.join(' | '));
  assert.ok(v.errors[0].indexOf('splitter "SPL B" (sp2) has 9 fibres leaving it') === 0, 'names sp2: ' + v.errors[0]);
  const cap = engine.network.capacity(p, registry);
  const rows = {};
  cap.splitterPorts.forEach(function (row) { rows[row.node] = row; });
  assert.strictEqual(rows.sp1.overbooked, false, 'sp1 uses one port');
  assert.strictEqual(rows.sp2.overbooked, true);
});

test('eight drops plus a downstream splitter is nine outputs, and is refused', function () {
  // 8 ONTs fill every port; the span to the child splitter then has none. The child is a cabled output
  // of the cassette, so it counts even though it carries one customer.
  const p = fanout(8);
  p.nodes.push({ id: 'sp2', type: 'splitter', model: 'plc-1x8-sca', name: 'SPL B', lat: 51.502, lon: -0.1 });
  p.nodes.push({ id: 'ont9', type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 9', lat: 51.503, lon: -0.1 });
  p.spans.push({ id: 's2', from: 'sp1', to: 'sp2', cable: 'g652d-loose-12', lengthM: 100 });
  p.spans.push({ id: 'd9', from: 'sp2', to: 'ont9', cable: 'g657a2-drop-1', lengthM: 30 });
  const v = engine.network.validate(p, registry);
  assert.strictEqual(v.ok, false, 'nine cabled outputs on an eight-port cassette');
  assert.ok(v.errors.some(function (e) { return e.indexOf('splitter "SPL 1:8" (sp1) has 9 fibres leaving it') === 0; }),
    'the first splitter is the overbooked one: ' + v.errors.join(' | '));
});

test('a splitter drawn but not connected to the OLT is a not-connected warning, not a port error', function () {
  // The isolated site has no branch behind it, so there is nothing to overbook. `validate` still warns
  // that it is off the tree, which is the warning a drawing in progress deserves.
  const p = fanout(8);
  p.nodes.push({ id: 'sp2', type: 'splitter', model: 'plc-1x8-sca', name: 'SPL island' });
  const v = engine.network.validate(p, registry);
  assert.deepStrictEqual(v.errors, [], 'an unconnected splitter is not an overbooked one');
  assert.ok(v.warnings.some(function (w) { return w.indexOf('"sp2" is not connected') !== -1; }),
    'the not-connected warning is still raised: ' + v.warnings.join(' | '));
});

test('an active plant reports no splitter ports at all', function () {
  const p = {
    nodes: [
      { id: 'h1', type: 'headend', model: 'sfp-plus-10g-lr-10km', name: 'HE' },
      { id: 'c1', type: 'ont', model: 'sfp-plus-10g-lr-10km', name: 'Site B' }
    ],
    spans: [{ id: 's1', from: 'h1', to: 'c1', cable: 'g652d-loose-12', lengthM: 5000 }]
  };
  const cap = engine.network.capacity(p, registry);
  assert.deepStrictEqual(cap.splitterPorts, [], 'an active network cannot hold a splitter');
  assert.strictEqual(cap.technology, 'active');
});

test('two splitter sites are counted one at a time, not as one budget', function () {
  // Two independent 1:8 sites, eight drops each: 16 ONTs, inside ports x ratio, and neither site over
  // its own eight. A plant-wide branch total would wrongly refuse this.
  const p = fanout(8);
  p.nodes.push({ id: 'sp2', type: 'splitter', model: 'plc-1x8-sca', name: 'SPL 2', lat: 51.51, lon: -0.1 });
  p.spans.push({ id: 's2', from: 'olt1', to: 'sp2', cable: 'g652d-loose-12', lengthM: 950 });
  for (let i = 1; i <= 8; i++) {
    p.nodes.push({ id: 'bont' + i, type: 'ont', model: 'gpon-ont-4ge', name: 'Norte ' + i });
    p.spans.push({ id: 'bd' + i, from: 'sp2', to: 'bont' + i, cable: 'g657a2-drop-1', lengthM: 35 });
  }
  const cap = engine.network.capacity(p, registry);
  assert.deepStrictEqual(cap.problems, [], 'each site is within its own eight ports');
  const used = cap.splitterPorts.map(function (r) { return r.portsUsed; }).sort();
  assert.deepStrictEqual(used, [8, 8]);
});

test('eight customers down one distribution cable fill a 1x8: eight fibres, one cable', function () {
  // The shape auto-design emits - `emitTerminalTree` gives the span one strand per ONT - reported
  // `portsUsed: 1`, because ports were counted in cabled branches. A cassette's port is one fibre, so
  // a splitter serving eight houses on one cable is full, not empty.
  const p = sharedCable(8);
  const v = engine.network.validate(p, registry);
  assert.deepStrictEqual(v.errors, [], 'eight fibres on eight ports is not a contradiction');
  const cap = engine.network.capacity(p, registry);
  assert.strictEqual(cap.splitterPorts.length, 1);
  assert.strictEqual(cap.splitterPorts[0].portsUsed, 8, 'one cable, eight customer fibres, eight ports');
  assert.strictEqual(cap.splitterPorts[0].overbooked, false, 'exactly full is not overbooked');
  assert.deepStrictEqual(cap.problems, []);
});

test('a ninth customer on that one cable is refused by name, not counted as healthy capacity', function () {
  // Nine ONTs, two cables, one of them carrying nine fibres: nine fibres need nine ports. The OLT-level
  // checks are both quiet here (cascade 8, 9 ONTs inside 8 x 64), so only the site's own port count can
  // refuse it - and it could not, while it counted cables.
  const p = sharedCable(9);
  const v = engine.network.validate(p, registry);
  assert.strictEqual(v.ok, false, 'nine customer fibres on a 1:8 cannot be built');
  assert.strictEqual(v.errors.length, 1, 'one contradiction, got: ' + v.errors.join(' | '));
  assert.strictEqual(v.errors[0],
    'splitter "SPL 1:8" (sp1) has 9 fibres leaving it on 8 output ports (plc-1x8-sca) - 1 fibre has no port',
    'the refusal counts fibres and names the site, the part and the shortfall: ' + v.errors[0]);
  const cap = engine.network.capacity(p, registry);
  assert.strictEqual(cap.splitterPorts[0].portsUsed, 9);
  assert.strictEqual(cap.splitterPorts[0].overbooked, true);
  assert.deepStrictEqual(cap.problems, [v.errors[0]], 'capacity reports the same sentence validate does');
});

test('a listed strand with no ONT behind it is spare, not a customer spending a port', function () {
  // A 12-fibre cable out of a 1:8 lists twelve strands and carries eight customers: the four spare
  // fibres are not ports in use, and counting them would refuse a design that is exactly full.
  const p = sharedCable(8, { listedFibres: 12 });
  const v = engine.network.validate(p, registry);
  assert.deepStrictEqual(v.errors, [], 'spare strands in the cable are not outputs in use');
  const cap = engine.network.capacity(p, registry);
  assert.strictEqual(cap.splitterPorts[0].portsUsed, 8, 'eight customers behind the cable');
});

test('two downstream splitters cost their parent two ports, whatever sits behind them', function () {
  // The cascade rule one level up from cables: one fibre per downstream splitter, and the ONTs behind
  // it are that splitter's ports, not this one's.
  const p = sharedCable(8);
  p.nodes.push({ id: 'c2', type: 'closure', model: 'nap-16', name: 'NAP 2' });
  p.nodes.push({ id: 'sp2', type: 'splitter', model: 'plc-1x8-sca', name: 'SPL B' });
  p.nodes.push({ id: 'sp3', type: 'splitter', model: 'plc-1x8-sca', name: 'SPL C' });
  p.spans.push({ id: 's3', from: 'c1', to: 'sp2', cable: 'g652d-loose-12', lengthM: 20, strands: [9] });
  p.spans.push({ id: 's4', from: 'c1', to: 'sp3', cable: 'g652d-loose-12', lengthM: 20, strands: [10] });
  const cap = engine.network.capacity(p, registry);
  const rows = {};
  cap.splitterPorts.forEach(function (row) { rows[row.node] = row; });
  assert.strictEqual(rows.sp1.portsUsed, 10, 'eight customers plus two downstream splitters');
  assert.strictEqual(rows.sp2.portsUsed, 0, 'a downstream splitter with nothing behind it spends none');
  assert.strictEqual(rows.sp1.overbooked, true, 'ten fibres on eight ports is over');
});

done();
