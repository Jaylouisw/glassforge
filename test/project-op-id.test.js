'use strict';
// Four ops act on an entry that already exists, by `id`: `update-node`, `move-node`, `remove-node`
// and `remove-span`. Send one without an `id` and it did not answer "you forgot a field" - it looked
// up `operation.id`, which is `undefined`, and refused with `unknown node "undefined"`. That sends
// the caller through the plant looking for a node with that name: the missing field is the cause and
// "unknown node" is the symptom, the same ordering `add-span` already avoids (`span.from and
// span.to are required`) and `rename` avoids (`rename needs a name`). An empty string is the other
// shape of the same slip: an untouched `<select>` or an unselected row sends `id: ""`.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

// A two-node, one-span plant, so each op has a real target to act on and the suites below can also
// show the tree is untouched by a refused edit.
function plant() {
  const project = engine.project.createProject('Op ids', { id: 'p-op-ids' });
  const root = engine.project.apply(project, { op: 'add-node', node: { id: 'n1', type: 'olt', model: 'gpon-c-plus-8' } });
  assert.ok(!root.error, root.error);
  const box = engine.project.apply(root.project, { op: 'add-node', node: { id: 'n2', type: 'closure', model: 'mufa-inline-24' } });
  assert.ok(!box.error, box.error);
  const span = engine.project.apply(box.project, { op: 'add-span', span: { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 100 } });
  assert.ok(!span.error, span.error);
  return span.project;
}

const NODE_OPS = [
  { op: 'update-node', patch: { name: 'Renamed' }, action: 'the node to update' },
  { op: 'move-node', lat: 51.5, lon: -0.1, action: 'the node to move' },
  { op: 'remove-node', action: 'the node to remove' }
];

test('an op with no id names the missing field, not a node called undefined', function () {
  for (const spec of NODE_OPS) {
    const operation = {};
    for (const key of Object.keys(spec)) if (key !== 'action') operation[key] = spec[key];
    const applied = engine.project.apply(plant(), operation, {});
    assert.ok(applied.error, spec.op + ' accepted an operation with no id');
    // The field is the cause: the sentence names `operation.id`, the op, and what the id is for.
    assert.ok(applied.error.indexOf('operation.id is required') === 0, applied.error);
    assert.ok(applied.error.indexOf(spec.op) !== -1, applied.error);
    assert.ok(applied.error.indexOf(spec.action) !== -1, applied.error);
    // And it does not name a node the caller never wrote, nor the value that was absent.
    assert.strictEqual(applied.error.indexOf('unknown node'), -1, applied.error);
    assert.strictEqual(applied.error.indexOf('undefined'), -1, applied.error);
  }
});

test('an empty string or null id is the same missing field, refused the same way', function () {
  for (const spec of NODE_OPS) {
    for (const id of ['', null]) {
      const operation = { id: id };
      for (const key of Object.keys(spec)) if (key !== 'action') operation[key] = spec[key];
      const applied = engine.project.apply(plant(), operation, {});
      assert.ok(applied.error, spec.op + ' accepted id ' + JSON.stringify(id));
      assert.ok(applied.error.indexOf('operation.id is required') === 0,
        spec.op + ' with id ' + JSON.stringify(id) + ': ' + applied.error);
    }
  }
});

test('remove-span with no id names the field too, and not a span called undefined', function () {
  for (const id of [undefined, '', null]) {
    const operation = id === undefined ? { op: 'remove-span' } : { op: 'remove-span', id: id };
    const applied = engine.project.apply(plant(), operation, {});
    assert.ok(applied.error, 'remove-span accepted id ' + JSON.stringify(id));
    assert.ok(applied.error.indexOf('operation.id is required') === 0, applied.error);
    assert.ok(applied.error.indexOf('remove-span') !== -1, applied.error);
    assert.ok(applied.error.indexOf('unknown span') === -1, applied.error);
  }
});

test('a real id that names nothing still says unknown, and a refused edit leaves the plant alone', function () {
  for (const op of [{ op: 'update-node', id: 'n9', patch: { name: 'x' } },
                    { op: 'move-node', id: 'n9', lat: 51.5, lon: -0.1 },
                    { op: 'remove-node', id: 'n9' }]) {
    const before = plant();
    const applied = engine.project.apply(before, op, {});
    assert.ok(applied.error, op.op + ' accepted a node id that does not exist');
    assert.ok(applied.error.indexOf('unknown node "n9"') === 0, applied.error);
    assert.strictEqual(applied.project, undefined, 'a refused edit must not hand back a project');
  }
  const span = engine.project.apply(plant(), { op: 'remove-span', id: 's9' }, {});
  assert.ok(span.error.indexOf('unknown span "s9"') === 0, span.error);
});

done();
