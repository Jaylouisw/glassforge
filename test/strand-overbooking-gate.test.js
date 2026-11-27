'use strict';
// Overbooking a span is a contradiction, not a red cell in one tab.
//
// SPEC §6: "14 strands assigned to a 12-fibre cable is a real drum somebody cannot splice, not a
// cosmetic warning." The ledger has always computed `overbooked`; `validate` never read it, so the
// save gate (`project.check` -> `network.validate`) accepted the plant, the printed plan rendered it
// as a clean design, and only the strands tab coloured one number red. That is the same advisory
// check `/ops` stopped making when it began refusing an unknown cable model: a caller is left with
// a new project and no reason to open the tab. `capacity` already turns an overbooked splitter site
// into an error; a cable's strands are the other capacity the plant carries, so they are gated the
// same way and by the ledger's own sentence (which names the span, the count and the cable).
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

function range(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(i);
  return out;
}

function plant(strands, extra) {
  const span = Object.assign({ id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 300 }, extra || {});
  if (strands !== undefined) span.strands = strands;
  return {
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', lat: 51.5, lon: -0.1 },
      { id: 'n2', type: 'ont', model: 'gpon-ont-4ge', lat: 51.501, lon: -0.1 }
    ],
    spans: [span]
  };
}

test('a span carrying more strands than its cable has is refused, naming the span and both counts', function () {
  // 13 strands of a 12-fibre cable: one drum somebody orders and cannot splice.
  const result = engine.network.validate(plant(range(13)), registry);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.errors, ['span "s1" uses 13 strands of a 12-fibre cable']);
  // The ledger is the one implementation of the count, and the gate quotes it rather than recounting.
  const ledger = engine.network.strandLedger(plant(range(13)), registry);
  assert.strictEqual(ledger.rows[0].overbooked, true);
  assert.strictEqual(ledger.rows[0].error, result.errors[0]);
});

test('the write gate refuses the same plant, so PUT and /ops cannot save it', function () {
  // The server runs `project.check` on PUT and on every op; both are this function.
  const bad = engine.project.check(plant(range(13)), registry);
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.indexOf('span "s1" uses 13 strands of a 12-fibre cable') !== -1,
    'the refusal has to name the span a caller can go and fix: ' + bad.errors.join('; '));
  // Twelve of twelve is a full cable, not a fault.
  assert.strictEqual(engine.project.check(plant(range(12)), registry).ok, true);
});

test('a bundled span has every cable\'s strands, so 18 on 2 x 12 is not overbooked', function () {
  // The ledger already counts `fiberCount * bundles`; the gate reads the ledger, so it must not
  // refuse the bundled span auto-design emits (a second cable is on the order).
  assert.strictEqual(engine.network.validate(plant(range(18), { bundles: 2 }), registry).ok, true);
  const over = engine.network.validate(plant(range(25), { bundles: 2 }), registry);
  assert.deepStrictEqual(over.errors, ['span "s1" uses 25 strands of 2 x 12-fibre cable']);
});

test('an absent strands list is spare capacity, not a fault', function () {
  assert.strictEqual(engine.network.validate(plant(undefined), registry).ok, true);
  assert.strictEqual(engine.network.validate(plant([]), registry).ok, true);
});

test('a span whose cable the catalogue lacks is refused for the model, not blamed on its strands', function () {
  // `strandLedger` cannot know the capacity of a model it does not have (`spare: null`), so it does
  // not call the span overbooked. The unknown model is already an error; one contradiction, one
  // sentence - a second "overbooked" line would send the caller to count strands for a typo.
  const result = engine.network.validate(plant(range(13), { cable: 'not-a-cable' }), registry);
  // This used to assert exactly 'span "s1" uses unknown cable model "not-a-cable"' - one sentence,
  // and no remedy in it. SPEC §8 wants an unknown model named with the models that do exist, so the
  // header is asserted and the catalogue tail separately; test/plant-validation.test.js pins the
  // full shape and the plain-string order.
  assert.strictEqual(result.errors.length, 1, JSON.stringify(result.errors));
  assert.ok(result.errors[0].indexOf('span "s1" uses unknown cable model "not-a-cable" - known models: ') === 0,
    result.errors[0]);
  assert.ok(result.errors[0].indexOf('g652d-loose-12') !== -1, result.errors[0]);
});

done();
