'use strict';
// `update-node` changes a node through `patch` - the header in `engine/project.js` and the
// operations block in `docs/API.md` both say so: `{ op: 'update-node', id, patch: { name?, model?,
// lat?, lon? } }`. Everything the op does not read it used to *ignore*: a field one level too high
// (`{ op, id, model }`), a `patch` that is text, a `patch` with no key, and a typo inside the patch
// all answered with the unchanged project and a new history entry. Measured on the code before this
// suite, through `project.apply` on a 1:8 estate:
//
//   { op:'update-node', id:'n3', model:'gpon-ont-4ge' }     200, model still gpon-ont-1ge
//   { op:'update-node', id:'n2', patch:{ nmae:'NAP 12' } }  200, name still null
//   { op:'update-node', id:'n2', patch:'x' }                200, no change
//   { op:'update-node', id:'n2', patch:{} }                 200, no change, history +1
//
// A 200 is how the API says "the edit landed" (docs/API.md: a refused operation is a 400 and leaves
// the saved project untouched). An op that applies nothing is neither: the caller's model is on no
// node, and an undo of the empty edit restores the same plant. The engine refuses a near miss
// everywhere else - `margindb`, `lng`, `modle` - so `patch` is closed the same way.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

function estate() {
  const project = engine.project.createProject('Update-node patch', { id: 'p-update-node-patch' });
  const ops = [
    { op: 'add-node', node: { id: 'n1', type: 'olt', model: 'gpon-b-plus-8', name: 'OLT' } },
    { op: 'add-node', node: { id: 'n2', type: 'splitter', model: 'plc-1x8-sca' } },
    { op: 'add-node', node: { id: 'n3', type: 'ont', model: 'gpon-ont-1ge', name: 'A' } },
    { op: 'add-span', span: { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 3000, splices: 1 } },
    { op: 'add-span', span: { id: 's2', from: 'n2', to: 'n3', cable: 'g657a2-drop-1', lengthM: 1 } }
  ];
  let plant = project;
  for (const op of ops) {
    const applied = engine.project.apply(plant, op);
    assert.ok(!applied.error, op.op + ': ' + applied.error);
    plant = applied.project;
  }
  return plant;
}

test('every refusal below is measured against a plant that budgets 11.86 dB of ODN', function () {
  const row = engine.network.allOntBudgets(estate(), registry, {})[0];
  // 0.66 (3000 m at 0.22 dB/km) + 0.00 (1 m) + 0.10 (one splice) + 0.60 (2 connectors) + 10.50 (1:8).
  assert.strictEqual(row.result.odnLossDb, 11.86, JSON.stringify(row.result.breakdown));
  assert.strictEqual(row.result.verdict, 'ok');
});

test('a field at the top level of update-node is refused, naming patch, not silently skipped', function () {
  const plant = estate();
  const applied = engine.project.apply(plant, { op: 'update-node', id: 'n3', model: 'gpon-ont-4ge' });
  assert.ok(applied.error, 'the model change was accepted and applied to nothing');
  assert.ok(applied.error.indexOf('patch') !== -1, applied.error);
  assert.ok(applied.error.indexOf('"model"') !== -1, applied.error);
  // A refusal hands back no project: the saved node still names the model the budget reads.
  const ont = plant.nodes.find(function (n) { return n.id === 'n3'; });
  assert.strictEqual(ont.model, 'gpon-ont-1ge');
});

test('a top-level typo of a patch field is refused with the suggestion', function () {
  const applied = engine.project.apply(estate(), { op: 'update-node', id: 'n2', modle: 'nap-16' });
  assert.ok(applied.error, 'a near miss at the top level was accepted');
  assert.ok(applied.error.indexOf('patch') !== -1, applied.error);
  assert.ok(applied.error.indexOf('"modle"') !== -1, applied.error);
  assert.ok(applied.error.indexOf('"model"') !== -1, applied.error);
});

test('a patch that is not an object is refused, not read as an empty edit', function () {
  for (const patch of ['x', 3, true, ['name']]) {
    const applied = engine.project.apply(estate(), { op: 'update-node', id: 'n2', patch: patch });
    assert.ok(applied.error, 'patch ' + JSON.stringify(patch) + ' was accepted');
    assert.ok(applied.error.indexOf('patch') !== -1, applied.error);
  }
});

test('a typo inside the patch is refused with the field it meant', function () {
  const plant = estate();
  const applied = engine.project.apply(plant, { op: 'update-node', id: 'n2', patch: { nmae: 'NAP 12' } });
  assert.ok(applied.error, 'the typo was accepted and renamed nothing');
  assert.ok(applied.error.indexOf('"nmae"') !== -1, applied.error);
  assert.ok(applied.error.indexOf('did you mean "name"') !== -1, applied.error);
  const splitter = plant.nodes.find(function (n) { return n.id === 'n2'; });
  assert.strictEqual(splitter.name, null);
});

test('an update-node with no field at all is refused and adds no history entry', function () {
  const plant = estate();
  for (const op of [
    { op: 'update-node', id: 'n2', patch: {} },
    { op: 'update-node', id: 'n2' }
  ]) {
    const applied = engine.project.apply(plant, op);
    assert.ok(applied.error, JSON.stringify(op) + ' was accepted as an empty edit');
    assert.ok(applied.error.indexOf('patch') !== -1, applied.error);
  }
  // Nothing was recorded, so the next undo takes back the last real edit.
  const undone = engine.project.undo(plant);
  assert.strictEqual(undone.undone.op, plant.history[plant.history.length - 1].op);
});

test('a well-formed patch still applies: name, model and a placement pair', function () {
  const named = engine.project.apply(estate(), { op: 'update-node', id: 'n2', patch: { name: 'NAP 12' } });
  assert.ok(!named.error, named.error);
  assert.strictEqual(named.project.nodes.find(function (n) { return n.id === 'n2'; }).name, 'NAP 12');
  const placed = engine.project.apply(named.project, { op: 'update-node', id: 'n2', patch: { lat: 51.5, lon: -0.1 } });
  assert.ok(!placed.error, placed.error);
  const node = placed.project.nodes.find(function (n) { return n.id === 'n2'; });
  assert.strictEqual(node.lat, 51.5);
  assert.strictEqual(node.lon, -0.1);
});

done();
