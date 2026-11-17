'use strict';
// The catalogue is the thing that grows, so its guard rails are load-bearing.
const { test, assert, throws, done } = require('./harness');
const parts = require('../engine/parts');

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
    txPowerDbmMin: 3, txPowerDbmMax: 7, rxSensitivityDbm: -30, rxOverloadDbm: -8,
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

done();
