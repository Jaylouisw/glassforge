'use strict';
// A planner is 50 edits from the design the user meant; undo is a feature, and it has to be exact.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

function fresh() {
  return engine.project.createProject('Undo test', { id: 'ptest', now: '2026-01-01T00:00:00.000Z' });
}

test('a new project is empty and has no history', function () {
  const p = fresh();
  assert.deepStrictEqual(p.nodes, []);
  assert.deepStrictEqual(p.spans, []);
  assert.strictEqual(p.history.length, 0);
});

test('adding a node never mutates the project it was given', function () {
  const before = fresh();
  const result = engine.project.apply(before, { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8' } });
  assert.ok(!result.error, result.error);
  assert.strictEqual(before.nodes.length, 0, 'the input project must be untouched');
  assert.strictEqual(result.project.nodes.length, 1);
  assert.strictEqual(result.project.nodes[0].id, 'n1');
});

test('ids are generated in sequence and stay unique', function () {
  let p = fresh();
  p = engine.project.apply(p, { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8' } }).project;
  p = engine.project.apply(p, { op: 'add-node', node: { type: 'closure', model: 'nap-8' } }).project;
  assert.deepStrictEqual(p.nodes.map(function (n) { return n.id; }), ['n1', 'n2']);
  p = engine.project.apply(p, { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 120 } }).project;
  assert.strictEqual(p.spans[0].id, 's1');
});

test('undo restores the previous state exactly', function () {
  let p = fresh();
  p = engine.project.apply(p, { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8' } }).project;
  const twoNodes = engine.project.apply(p, { op: 'add-node', node: { type: 'closure', model: 'nap-8' } }).project;
  const undone = engine.project.undo(twoNodes);
  assert.strictEqual(undone.undone.op, 'add-node n2');
  assert.strictEqual(undone.project.nodes.length, 1);
  assert.deepStrictEqual(undone.project.nodes, p.nodes);
});

test('history is capped at 50 and the oldest falls off', function () {
  let p = fresh();
  for (let i = 0; i < 60; i++) {
    p = engine.project.apply(p, { op: 'rename', name: 'name ' + i }).project;
  }
  assert.strictEqual(p.history.length, engine.project.MAX_HISTORY);
  let steps = 0;
  while (p.history.length) { p = engine.project.undo(p).project; steps++; }
  assert.strictEqual(steps, 50, 'fifty undos are available, not sixty');
});

test('removing a node takes its spans with it', function () {
  let p = fresh();
  p = engine.project.apply(p, { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8' } }).project;
  p = engine.project.apply(p, { op: 'add-node', node: { type: 'closure', model: 'nap-8' } }).project;
  p = engine.project.apply(p, { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 100 } }).project;
  p = engine.project.apply(p, { op: 'remove-node', id: 'n2' }).project;
  assert.strictEqual(p.nodes.length, 1);
  assert.strictEqual(p.spans.length, 0, 'a span hanging off a deleted node is a dangling reference');
});

test('bad edits are refused with a reason and change nothing', function () {
  const p = engine.project.apply(fresh(), { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8' } }).project;
  const cases = [
    [{ op: 'add-span', span: { from: 'n1', to: 'n9', cable: 'g652d-loose-12', lengthM: 10 } }, 'unknown node'],
    [{ op: 'add-span', span: { from: 'n1', to: 'n1', cable: 'g652d-loose-12', lengthM: 10 } }, 'same node'],
    [{ op: 'add-span', span: { from: 'n1', to: 'n1', cable: 'g652d-loose-12', lengthM: 0 } }, 'same node'],
    [{ op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8' } }, 'already has an OLT'],
    [{ op: 'add-node', node: { type: 'nonsense' } }, 'node.type must be'],
    [{ op: 'move-node', id: 'nope', lat: 1, lon: 2 }, 'unknown node'],
    [{ op: 'rename', name: '   ' }, 'needs a name'],
    [{ op: 'fly' }, 'unknown op']
  ];
  for (const [operation, needle] of cases) {
    const result = engine.project.apply(p, operation);
    assert.ok(result.error && result.error.indexOf(needle) !== -1,
      JSON.stringify(operation) + ' should fail mentioning "' + needle + '", got ' + result.error);
    assert.ok(!result.project, 'a refused op returns no project');
  }
});

test('a span needs a positive measured length', function () {
  let p = engine.project.apply(fresh(), { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8' } }).project;
  p = engine.project.apply(p, { op: 'add-node', node: { type: 'closure', model: 'nap-8' } }).project;
  const result = engine.project.apply(p, { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: -5 } });
  assert.ok(result.error.indexOf('positive number') !== -1, result.error);
});

test('the project summary agrees with the plant', function () {
  let p = fresh();
  p = engine.project.apply(p, { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8' } }).project;
  p = engine.project.apply(p, { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-1ge' } }).project;
  p = engine.project.apply(p, { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g657a2-drop-1', lengthM: 80 } }).project;
  const summary = engine.project.summary(p, registry);
  assert.strictEqual(summary.nodes, 2);
  assert.strictEqual(summary.spans, 1);
  assert.strictEqual(summary.onts, 1);
  assert.strictEqual(summary.routeM, 80);
});

// A project file is JSON somebody can edit, and `PUT /api/projects/:id` merges the caller's body
// into the saved project. On main at 8fe54e6, `PUT {"history":"x"}` answered 200 and the next
// `/undo` answered 500 `history.pop is not a function` - a stack-level sentence from a field the
// caller sent, with the server blamed for it. `history` is a list of undo entries and a field that
// is not one is refused by name, the same way every other field is.
test('undo refuses a history that is not a list, naming the field', function () {
  const p = fresh();
  p.history = 'x';
  let message = null;
  try { engine.project.undo(p); } catch (err) { message = err.message; }
  assert.ok(message, 'undo must refuse a string history instead of throwing pop is not a function');
  assert.ok(/history must be an array of undo entries/.test(message), message);
  assert.ok(/got "x"/.test(message), 'the refusal quotes what arrived: ' + message);
});

test('an op on a project whose history is not a list is refused with the same sentence', function () {
  const p = fresh();
  p.history = { a: 1 };
  const result = engine.project.apply(p, { op: 'rename', name: 'x' });
  assert.ok(result.error && /history must be an array of undo entries/.test(result.error), result.error);
  assert.ok(!result.project, 'a refused op returns no project');
});

test('an undo entry without a state is refused by its index, not dereferenced', function () {
  // `history: [1]` reached `last.state.name` and answered 500 `Cannot read properties of undefined
  // (reading 'name')`. An undo restores an entry's state, so an entry without one is nothing to go
  // back to and the refusal says which entry.
  const p = fresh();
  p.history = [1];
  let message = null;
  try { engine.project.undo(p); } catch (err) { message = err.message; }
  assert.ok(message && /history\[0\]/.test(message), message);
  assert.ok(/state/.test(message), message);
});

test('a plant cannot be swapped in over a history that is not a list', function () {
  // The design's `applyToProject` goes through `replacePlant`, which takes a snapshot: a string
  // history made `concat` produce `x[object Object]` and the corrupt history was saved back.
  const p = fresh();
  p.history = 'x';
  const result = engine.project.replacePlant(p, { nodes: [], spans: [] });
  assert.ok(result.error && /history must be an array of undo entries/.test(result.error), result.error);
  assert.ok(!result.project, 'a refused replace returns no project');
});
