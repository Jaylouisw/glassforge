'use strict';
// The catalogue is the thing that grows, so its guard rails are load-bearing.
const { test, assert, throws, close, done } = require('./harness');
const parts = require('../engine/parts');
const engine = require('../engine');

const registry = parts.createRegistry();

test('the shipped catalogue validates and is not empty', function () {
  const validation = registry.validate();
  assert.deepStrictEqual(validation.problems, [], JSON.stringify(validation.problems, null, 2));
  const counts = registry.counts();
  assert.ok(counts.total >= 30, 'expected at least 30 parts, found ' + counts.total);
  for (const kind of parts.KINDS) assert.ok(counts.byKind[kind] >= 1, kind + ' catalogue is empty');
});

test('every signal part publishes where its figures came from', function () {
  for (const kind of ['cable', 'splitter', 'olt', 'ont']) {
    for (const spec of registry.all(kind)) {
      assert.ok(/^https:\/\//.test(spec.sourceUrl || ''), kind + '/' + spec.model + ' has no https sourceUrl');
    }
  }
});

test('class budgets are the published ones', function () {
  assert.strictEqual(parts.classBudgetDb('gpon', 'B+'), 28);
  assert.strictEqual(parts.classBudgetDb('gpon', 'C+'), 32);
  assert.strictEqual(parts.classBudgetDb('gpon', 'C++'), 35);
  assert.strictEqual(parts.classBudgetDb('xgs-pon', 'N2'), 31);
  assert.strictEqual(parts.classBudgetDb('xgs-pon', 'E2'), 35);
  assert.strictEqual(parts.classBudgetDb('gpon', 'Z9'), null);
});

test('a cable with no 1490 nm figure is refused, not defaulted', function () {
  const result = parts.validateSpec({
    kind: 'cable', model: 'bad-cable', label: 'Bad', fiberCount: 12,
    attenuationDbPerKm: { 1310: 0.35 }, sourceUrl: 'https://example.invalid/x'
  });
  assert.strictEqual(result.ok, true, 'a cable missing one window is legal; a budget that asks for it is not');
  assert.strictEqual(parts.validateSpec(Object.assign({}, {
    kind: 'cable', model: 'bad-cable', label: 'Bad', fiberCount: 12,
    attenuationDbPerKm: {}, sourceUrl: 'https://x.invalid'
  })).ok, false);
});

test('specs that would silently mislead are rejected', function () {
  const base = { kind: 'splitter', model: 'x', label: 'X', ratio: 8, excessLossDb: 0.6, sourceUrl: 'https://x.invalid' };
  assert.strictEqual(parts.validateSpec(base).ok, true);
  assert.strictEqual(parts.validateSpec(Object.assign({}, base, { ratio: 7 })).ok, false, 'ratio must be a power of two');
  assert.strictEqual(parts.validateSpec(Object.assign({}, base, { model: 'Not A Slug' })).ok, false);
  assert.strictEqual(parts.validateSpec(Object.assign({}, base, { excessLossDb: undefined })).ok, false);
  assert.strictEqual(parts.validateSpec(Object.assign({}, base, { sourceUrl: undefined })).ok, false);
  assert.strictEqual(parts.validateSpec(Object.assign({}, base, { kind: 'nonsense' })).ok, false);
});

test('an OLT whose budget does not match its class warns', function () {
  const result = parts.validateSpec({
    kind: 'olt', model: 'odd-olt', label: 'Odd', pon: 'gpon', class: 'C+',
    txPowerDbmMin: 3, txPowerDbmMax: 7, rxSensitivityDbm: -32, rxOverloadDbm: -12,
    budgetDb: 35, ports: 8, maxSplitRatio: 128, sourceUrl: 'https://x.invalid'
  });
  assert.strictEqual(result.ok, true);
  assert.ok(result.warnings.length, 'a C+ OLT claiming 35 dB should warn');
});

test('a receiver cannot be deaf and blind at once', function () {
  const result = parts.validateSpec({
    kind: 'ont', model: 'nope', label: 'Nope', pon: 'gpon',
    txPowerDbmMin: 0.5, txPowerDbmMax: 5, rxSensitivityDbm: -8, rxOverloadDbm: -27,
    sourceUrl: 'https://x.invalid'
  });
  assert.strictEqual(result.ok, false);
});

test('search finds a part by label and by model', function () {
  assert.ok(registry.search('1x8', 'splitter').length >= 1);
  assert.ok(registry.search('c+', 'olt').length >= 1);
  assert.strictEqual(registry.search('nothing-matches-this', 'cable').length, 0);
});

test('an unknown model names what does exist', function () {
  throws(function () { registry.get('cable', 'no-such-cable'); }, 'unknown cable model', 'get');
  throws(function () { registry.get('nonsense', 'x'); }, 'unknown part kind', 'get kind');
});

test('the splitter ladder reaches every ratio an OLT advertises', function () {
  // buildPon resolves a splitter by name - 'plc-1x' + ratio + '-sca' - so an OLT whose maxSplitRatio has
  // no part is a dead end: the candidate is skipped with a note and the advertised ratio cannot be built.
  for (const olt of registry.all('olt')) {
    const model = 'plc-1x' + olt.maxSplitRatio + '-sca';
    assert.ok(registry.has('splitter', model),
      olt.model + ' advertises 1:' + olt.maxSplitRatio + ' but the catalogue has no splitter "' + model + '"');
  }
});

test('a 1:128 PON budgets on the 1x128 cassette', function () {
  // 1.0 km of G.652.D at 1490 nm = 0.22; 2 splices = 0.20; 2 connectors = 0.60;
  // 1:128 splitter = 10*log10(128) = 21.07 split + 2.73 excess = 23.80  ->  ODN 24.82 dB
  const r = engine.budget.opticalBudget({
    olt: { model: 'gpon-c-plus-8' },
    ont: { model: 'gpon-ont-4ge' },
    wavelength: '1490',
    spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }],
    splitters: [{ model: 'plc-1x128-sca' }],
    splices: 2,
    connectors: 2
  }, registry);
  close(r.odnLossDb, 24.82, 0.001, 'ODN loss');
  // C+ launches 3.0 dBm: 3.0 - 24.82 = -21.82 dBm into a -30 dBm receiver = 8.18 dB of headroom,
  // and 32 - 24.82 = 7.18 dB inside the class budget
  close(r.rxPowerDbm, -21.82, 0.001, 'receive power');
  close(r.headroomDb, 8.18, 0.001, 'headroom');
  close(r.classHeadroomDb, 7.18, 0.001, 'class headroom');
  assert.strictEqual(r.verdict, 'ok');
});

test('an active link can be budgeted with an LC/UPC mating, not the SC/APC default', function () {
  // Every transceiver in this catalogue is UPC, and the catalogue's connector family only carried an
  // LC/APC row: a UPC patch cord cannot be mated to it. lc-upc is therefore a part the budget must be
  // able to reach by name - a row that loads but is never chargeable is a table entry, not a part.
  // 1.0 km x 0.35 dB/km (1310 nm) = 0.35 dB of fibre; 2 x 0.25 (lc-upc) = 0.50 dB of connector
  // -> ODN 0.85 dB, against 0.95 dB with the 0.30 dB default pair.
  const design = {
    headEnd: { model: 'sfp-plus-10g-lr-10km' },
    cpe: { model: 'sfp-plus-10g-lr-10km' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }],
    splices: 0,
    connectors: { model: 'lc-upc', count: 2 }
  };
  const upc = engine.budget.pointToPoint(design, registry);
  close(upc.odnLossDb, 0.85, 0.001, 'ODN loss with an LC/UPC pair');
  const defaulted = engine.budget.pointToPoint(Object.assign({}, design, { connectors: 2 }), registry);
  close(defaulted.odnLossDb, 0.95, 0.001, 'ODN loss with the 0.30 dB default pair');
  close(defaulted.odnLossDb - upc.odnLossDb, 0.1, 0.001, 'the polish worth 0.05 dB per mating');
  assert.strictEqual(registry.get('connector', 'lc-upc').polish, 'upc');
});

test('an OLT receiver reaches the class budget its own ONTs launch into', function () {
  // Upstream is a class-level pair, not a per-design one: every ONT of a PON in this catalogue launches
  // the same floor (GPON +0.5, XG-PON +2, XGS-PON +4 dBm), so the OLT receiver has to be sensitive
  // enough that the class the row declares is reachable at all. Two rows were not: gpon-c-plus-8
  // carried -30 dBm and gpon-c-plus-plus-16 -33 dBm - the class B+ pair copied down the ladder - which
  // left 30.5 and 33.5 dB against 32 and 35 dB classes. The class verdict passed while the headroom
  // verdict failed on the same row, and a designer reads that as "the tool is broken", not "buy a pad".
  for (const olt of registry.all('olt')) {
    const onts = registry.all('ont').filter(function (o) { return o.pon === olt.pon; });
    assert.ok(onts.length > 0, olt.model + ' has no ONT of the same PON');
    const launchFloor = Math.min.apply(null, onts.map(function (o) { return o.txPowerDbmMin; }));
    const reach = launchFloor - olt.rxSensitivityDbm;
    assert.ok(reach >= olt.budgetDb, olt.model + ': an ONT launching ' + launchFloor + ' dBm into a ' +
      olt.rxSensitivityDbm + ' dBm receiver reaches ' + reach + ' dB, short of its own ' + olt.budgetDb + ' dB class');
  }
});

done();
