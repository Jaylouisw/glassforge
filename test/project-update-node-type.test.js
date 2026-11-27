'use strict';
// `update-node` copies `type` out of its patch, and `type` is not part of the op: the header in
// `engine/project.js` and `docs/API.md` both list `patch` as name, model, lat, lon. Copying it is
// not a cosmetic leak, because a node's type is what the engine reads to decide two things:
// `trace`/`computeOdn` charge a splitter's loss only on a node of type `splitter`, and the root's
// type picks the technology (`olt` budgets a PON, `headend` an active link). Measured on the code
// before this test, through `project.apply` on a healthy 1:8 estate (1.2 km g652d-loose-12, 300 m
// g657a2-drop-2, gpon-c-plus-8 into gpon-ont-4ge):
//
//   as saved            ODN 11.53 dB   verdict ok
//   patch {type:'closure'} on the splitter   ODN 1.03 dB   verdict fail - "1.97 dBm at the ONT is
//                                            above its overload point, fit a 14 dB pad"
//
// The 10.5 dB of splitter loss left the budget with a 200 and a `warnings` line about an unknown
// closure model - the storer accepted a plant the engine can no longer describe. Retyping the only
// ONT to a closure has the same shape and a worse answer: the customer disappears from `/budget`
// and the BOM. A node of another kind is a remove and an add, not an edit of this one.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

function pon() {
  const project = engine.project.createProject('Update-node typing', { id: 'p-update-node' });
  const p = engine.project.apply(project, {
    op: 'add-node', node: { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' }
  });
  assert.ok(!p.error, p.error);
  const s = engine.project.apply(p.project, {
    op: 'add-node', node: { id: 'n2', type: 'splitter', model: 'plc-1x8-sca', name: 'S1' }
  });
  assert.ok(!s.error, s.error);
  const o = engine.project.apply(s.project, {
    op: 'add-node', node: { id: 'n3', type: 'ont', model: 'gpon-ont-4ge', name: 'A' }
  });
  assert.ok(!o.error, o.error);
  const a = engine.project.apply(o.project, {
    op: 'add-span', span: { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 1200, splices: 1 }
  });
  assert.ok(!a.error, a.error);
  const b = engine.project.apply(a.project, {
    op: 'add-span', span: { id: 's2', from: 'n2', to: 'n3', cable: 'g657a2-drop-2', lengthM: 300, splices: 1 }
  });
  assert.ok(!b.error, b.error);
  return b.project;
}

test('the healthy estate this suite measures against is an 11.53 dB ODN that reports ok', function () {
  const plant = pon();
  const row = engine.network.allOntBudgets(plant, registry, {})[0];
  // 0.264 (1200 m at 0.22 dB/km) + 0.066 (300 m) + 0.10 (splice) + 0.60 (2 connectors) + 10.50 (1:8).
  assert.strictEqual(row.result.odnLossDb, 11.53, JSON.stringify(row.result.breakdown));
  assert.strictEqual(row.result.verdict, 'ok');
});

test('an update-node that retypes a splitter to a closure is refused, naming the node and the field', function () {
  const plant = pon();
  const applied = engine.project.apply(plant, { op: 'update-node', id: 'n2', patch: { type: 'closure' } });
  assert.ok(applied.error, 'the retype was accepted, so the splitter loss would leave the ODN');
  assert.ok(applied.error.indexOf('"n2"') !== -1, applied.error);
  assert.ok(applied.error.indexOf('type') !== -1, applied.error);
  assert.ok(applied.error.indexOf('"closure"') !== -1, applied.error);
  // The refused op leaves no mark: the draft is a clone, and the caller's plant is untouched.
  assert.strictEqual(plant.nodes[1].type, 'splitter');
});

test('a refused retype leaves the plant budgeting the loss it had', function () {
  const plant = pon();
  const applied = engine.project.apply(plant, { op: 'update-node', id: 'n2', patch: { type: 'closure' } });
  assert.ok(applied.error, applied.error);
  const row = engine.network.allOntBudgets(applied.project || plant, registry, {})[0];
  assert.strictEqual(row.result.odnLossDb, 11.53, 'the 10.5 dB splitter loss is gone');
  assert.strictEqual(row.result.verdict, 'ok');
});

test('retyping the only ONT is refused too, so a customer cannot vanish from /budget silently', function () {
  const applied = engine.project.apply(pon(), { op: 'update-node', id: 'n3', patch: { type: 'closure' } });
  assert.ok(applied.error, 'a customer was deleted with a 200');
  assert.ok(applied.error.indexOf('"n3"') !== -1, applied.error);
});

test('the same type echoed back is not a change, so a writer that sends the whole node still works', function () {
  const applied = engine.project.apply(pon(), { op: 'update-node', id: 'n2', patch: { type: 'splitter', name: 'S1 renamed' } });
  assert.ok(!applied.error, applied.error);
  assert.strictEqual(applied.project.nodes[1].name, 'S1 renamed', 'the name in the same patch was dropped');
  assert.strictEqual(applied.project.nodes[1].type, 'splitter');
});

test('a type that is not a node type is refused by name, not stored as a warning', function () {
  const applied = engine.project.apply(pon(), { op: 'update-node', id: 'n2', patch: { type: 'router' } });
  assert.ok(applied.error, applied.error);
  assert.ok(applied.error.indexOf('"router"') !== -1, applied.error);
});

done();
