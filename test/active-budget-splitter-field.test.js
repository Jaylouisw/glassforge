'use strict';
// The active budget refuses a splitter handed to it directly, not only one drawn as a plant node.
//
// `network.designForOnt` already refuses a splitter on an active *path* by naming the node
// (test/active-splitter-budget.test.js): a headend root is a link between two optics, and a splitter
// is a PON element (SPEC 8, invariant 0). The direct entry point did not. `budget.pointToPoint` reads
// its design through the shared `computeOdn` - which is right, both technologies charge the same
// losses for the same plant - and `computeOdn` charges whatever `design.splitters` holds, while
// `ACTIVE_DESIGN_FIELDS` did not name the field, so the key list claimed the active budget does not
// read a list it charges.
//
// Measured on main at 009d3ce, a 2 km link between two 10G-LR optics:
//
//   without splitters   fibre 2 km x 0.35 dB/km = 0.70 dB   ODN 0.70 -> headroom 5.50, "ok"
//   with a 1:8 splitter fibre 0.70 + splitter 10.50 = 11.20 dB ODN 11.20 -> "fail"
//     reasons: "headroom -5 dB is below the 3 dB design margin" and
//              "link loss 11.2 dB exceeds the 6.2 dB this optic pair can afford"
//
// So the answer charged 10.5 dB of a part the technology forbids and then blamed the route: the
// remedy a planner reads out of it ("this pair cannot afford the link") is the wrong purchase. The
// figure is real but describes a network that cannot be built, so the design is refused by name -
// the same way the plant path refuses the node - and the PON budget keeps charging the splitter it
// is allowed to carry.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

/** Two 10G-LR optics 2 km apart - 0.70 dB of fibre at the optic's own 1310 nm. */
function active(spans) {
  return {
    headEnd: { model: 'sfp-plus-10g-lr-10km' },
    cpe: { model: 'sfp-plus-10g-lr-10km' },
    spans: spans || [{ lengthM: 2000, cable: 'g652d-loose-12' }]
  };
}

// ------------------------------------------------------------------ the refusal

test('the active budget refuses a splitter in its design rather than charging it', function () {
  const design = active();
  design.splitters = [{ model: 'plc-1x8-sca' }];
  const err = throws(function () {
    engine.budget.pointToPoint(design, registry);
  }, 'splitters', 'pointToPoint with a splitter');
  assert.ok(err instanceof TypeError, 'a caller-caused refusal is a TypeError, got ' + err.name);
  assert.ok(String(err.message).indexOf('plc-1x8-sca') !== -1,
    'the refusal should name the splitter the design carries: ' + err.message);
  assert.ok(String(err.message).indexOf('cannot be built') !== -1,
    'the refusal should say why a charged figure is not the answer: ' + err.message);
  assert.ok(String(err.message).indexOf('opticalBudget') !== -1,
    'the refusal should point at the budget that may carry a splitter: ' + err.message);
});

test('the refusal is the topology rule, not the fibre count: two splitters are named too', function () {
  const design = active();
  design.splitters = [{ model: 'plc-1x8-sca' }, { model: 'plc-1x4-sca' }];
  const err = throws(function () {
    engine.budget.pointToPoint(design, registry);
  }, '2 splitters', 'pointToPoint with two splitters');
  assert.ok(String(err.message).indexOf('plc-1x4-sca') !== -1,
    'every splitter the design carries should be named: ' + err.message);
});

test('a list the budget cannot read is refused by its shape, not as a splitter', function () {
  // `splitters: null` means "none" to a JSON author, and the shared `listField` already refuses it
  // with the sentence about a dropped list deleting the loss it names. The topology refusal must not
  // take that case over and tell a caller who sent no splitter that active links have none.
  const design = active();
  design.splitters = null;
  throws(function () {
    engine.budget.pointToPoint(design, registry);
  }, 'design.splitters must be an array', 'pointToPoint with a null splitter list');
});

// ------------------------------------------------------------------ what is still answered

test('an empty splitter list is not a splitter: the control link still budgets', function () {
  const design = active();
  design.splitters = [];
  const result = engine.budget.pointToPoint(design, registry);
  // 2 km x 0.35 dB/km at 1310 nm = 0.70 dB; 10G-LR budget 6.2 dB -> headroom 5.50 dB.
  close(result.odnLossDb, 0.7, 0.001, 'ODN loss without a splitter');
  close(result.headroomDb, 5.5, 0.01, 'headroom without a splitter');
  assert.strictEqual(result.verdict, 'ok');
});

test('the PON budget still charges the splitter it is allowed to carry', function () {
  // 2 km x 0.22 dB/km at 1490 nm = 0.44 dB, plus the 1:8's 10.50 dB insertion loss = 10.94 dB.
  const result = engine.budget.opticalBudget({
    olt: { model: 'gpon-c-plus-8' },
    ont: { model: 'gpon-ont-4ge' },
    spans: [{ lengthM: 2000, cable: 'g652d-loose-12' }],
    splitters: [{ model: 'plc-1x8-sca' }]
  }, registry);
  close(result.odnLossDb, 10.94, 0.01, 'PON ODN loss with a splitter');
  assert.strictEqual(result.breakdown.filter(function (b) { return b.kind === 'splitter'; }).length, 1,
    'the PON budget reports the splitter in its breakdown');
});

test('the splitter typo is now answered with the field the active budget does name', function () {
  // `splitter` (singular) is a near miss of nothing on the old list, so it was an unrelated key and
  // the default ran - with the splitter silently absent from an answer the caller believed included
  // it. Now the near-miss guard names the field, and the field itself carries the topology refusal.
  const design = active();
  design.splitter = { model: 'plc-1x8-sca' };
  const err = throws(function () {
    engine.budget.pointToPoint(design, registry);
  }, 'did you mean "splitters"', 'pointToPoint with a singular splitter');
  assert.ok(String(err.message).indexOf('splitters') !== -1, err.message);
});

done();
