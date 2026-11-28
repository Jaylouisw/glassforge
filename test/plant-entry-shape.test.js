'use strict';
// A list entry that is not a node or a span is a fault row, not a stack trace.
//
// A project is a JSON file, and a JSON file can hold `null` where an object belongs - a hand edit
// with a trailing comma, a merge that dropped a line, an import that kept a blank. `validate` has
// always *meant* to report that (`a node has no id`), but the pass after its own root check read
// `node.type` on the entry without the `n &&` guard every sibling filter carries, so the check threw
// instead of refusing. Measured on main before this suite, driven through the real server:
//
//   PUT /api/projects/:id {nodes:[{olt}, null]}  -> 500 "Cannot read properties of null (reading 'type')"
//   GET /api/projects/:id        (same file)      -> 500, so the project cannot even be opened to fix
//   GET /print/project/:id                        -> the same crash out of `stats`/`spliceTable`
//
// Every one of those is the caller's (or the file's) mistake, and the engine's rule for that is a
// named 400, not "the server broke". The derived readers run on plants that never met the save gate
// (a file predating it, a `PUT` in flight), so each of them has to see the entry and skip it rather
// than dereference it.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

/** A healthy little PON: OLT -> closure -> ONT, two strands through the closure. */
function pon() {
  return {
    name: 'Entry shape',
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', lat: 51.5, lon: -0.1 },
      { id: 'n2', type: 'closure', model: 'mufa-inline-24', lat: 51.5005, lon: -0.1 },
      { id: 'n3', type: 'ont', model: 'gpon-ont-4ge', lat: 51.501, lon: -0.1 }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 300, strands: [1, 2] },
      { id: 's2', from: 'n2', to: 'n3', cable: 'g652d-loose-12', lengthM: 40, strands: [1, 2] }
    ]
  };
}

function withoutExtraEntry(plantName) {
  // The healthy plant, so the assertions below are about the extra entry alone.
  assert.strictEqual(engine.network.validate(pon(), registry).ok, true, 'the fixture is a valid plant, not a ' + plantName);
}

test('a null in nodes is refused by the validator, not thrown at it', function () {
  withoutExtraEntry('crash');
  const plant = pon();
  plant.nodes.push(null);
  const result = engine.network.validate(plant, registry);
  assert.strictEqual(result.ok, false);
  // One fault, one sentence, and it says which entry: the position is what a caller edits.
  assert.strictEqual(result.errors.length, 1, result.errors.join('; '));
  assert.ok(result.errors[0].indexOf('nodes[3] is not a node object') === 0, result.errors[0]);
});

test('a node object with no id is still named by position', function () {
  const plant = pon();
  plant.nodes.push({ type: 'closure', model: 'mufa-inline-24' });
  assert.deepStrictEqual(engine.network.validate(plant, registry).errors, ['node #3 has no id']);
});

test('a null in spans is refused by the validator and by the write gate', function () {
  const plant = pon();
  plant.spans.push(null);
  const result = engine.network.validate(plant, registry);
  assert.strictEqual(result.errors.length, 1, result.errors.join('; '));
  assert.ok(result.errors[0].indexOf('spans[2] is not a span object') === 0, result.errors[0]);
  // The server's PUT and every /ops call run this; a refusal has to be `ok: false`, not an exception.
  const gate = engine.project.check(plant, registry);
  assert.strictEqual(gate.ok, false);
  assert.ok(gate.errors.indexOf(result.errors[0]) !== -1, gate.errors.join('; '));
});

test('the derived readers skip an unreadable entry instead of dereferencing it', function () {
  const nullNode = pon();
  nullNode.nodes.push(null);
  const nullSpan = pon();
  nullSpan.spans.push(null);

  for (const plant of [nullNode, nullSpan]) {
    // `capacity` counts the readable ONTs, `stats` wraps it, `summary` wraps that: the three readers
    // `GET /api/projects/:id` builds its `derived` block from.
    assert.strictEqual(engine.network.capacity(plant, registry).onts, 1);
    assert.strictEqual(engine.network.stats(plant, registry).onts, 1);
    assert.strictEqual(engine.project.summary(plant, registry).onts, 1);
  }
});

test('the strand ledger answers the readable spans, not a 500', function () {
  const plant = pon();
  plant.spans.push(null);
  const ledger = engine.network.strandLedger(plant, registry);
  // Two readable spans: 12 fibres each, 2 in use.
  assert.strictEqual(ledger.rows.length, 2);
  assert.strictEqual(ledger.totalStrands, 24);
  assert.strictEqual(ledger.totalUsed, 4);
});

test('the splice sheet and the signal rows survive the same file', function () {
  const plant = pon();
  plant.nodes.push(null);
  plant.spans.push(null);
  const sheet = engine.network.spliceTable(plant, registry);
  assert.ok(sheet.points.length >= 1, 'the closure is still a splice point');
  const budgets = engine.network.allOntBudgets(plant, registry);
  assert.strictEqual(budgets.length, 1);
  assert.ok(budgets[0].result, 'the one ONT is budgeted: ' + budgets[0].error);
});

test('the bill of materials refuses an unreadable span by position, it does not skip it', function () {
  const plant = pon();
  plant.spans.push(null);
  // A purchase order may not drop a line: the plan would be bought a drum short. `/bom` answers the
  // same sentence as a 400 (measured through the server), not a 500.
  let message = null;
  try { engine.length.billOfMaterials(plant, registry, {}); } catch (err) { message = err.message; }
  assert.ok(message && message.indexOf('span #2 is not a span object') === 0, String(message));
});

test('the plan projection skips an unreadable node instead of throwing', function () {
  const scene = require('../web/scene');
  const projected = scene.project([{ id: 'n1', lat: 51.5, lon: -0.1 }, null], { width: 400, height: 300 });
  assert.strictEqual(projected.nodes.length, 1);
  assert.strictEqual(projected.nodes[0].id, 'n1');
});

done();
