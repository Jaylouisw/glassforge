'use strict';
// A design field the budget does not read is a typo, and a typo that names loss must not be skipped.
//
// The defect this suite pins: `opticalBudget` read `design.splitters` and ignored `design.splitter`,
// so a caller who wrote the singular got a budget with the splitter missing - on a 15 km GPON B+
// design, ODN 4.3 dB instead of 14.8 dB, a received power 10.5 dB optimistic, and a verdict computed
// on fibre that will not light. No error, no warning, HTTP 200.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

// 15.0 km g652d-loose-12 @ 1490 nm: 15.0 x 0.22 = 3.30; 4 splices x 0.10 = 0.40;
// 2 connectors x 0.30 = 0.60; plc-1x8-sca 9.03 dB + 1.47 dB excess = 10.50  ->  ODN 14.80 dB
function longPon(overrides) {
  return Object.assign({
    olt: { model: 'gpon-b-plus-8' },
    ont: { model: 'gpon-ont-1ge' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 15000 }],
    splices: 4,
    connectors: 2,
    splitters: [{ model: 'plc-1x8-sca' }]
  }, overrides || {});
}

test('the correct plural budgets the splitter', function () {
  const r = budget.opticalBudget(longPon(), registry);
  close(r.odnLossDb, 14.8, 0.001, 'ODN loss with the 1:8 splitter');
  close(r.rxPowerDbm, 1.5 - 14.8, 0.001, 'receive power at the +1.5 dBm launch floor');
});

test('a singular `splitter` is refused, naming the field that was meant', function () {
  const typo = longPon({ splitters: undefined, splitter: { model: 'plc-1x8-sca' } });
  throws(function () { budget.opticalBudget(typo, registry); }, 'splitters', 'the suggestion');
});

test('the refusal says a near miss is skipped loss, not a setting', function () {
  const typo = longPon({ splitters: undefined, splitter: { model: 'plc-1x8-sca' } });
  let message = '';
  try { budget.opticalBudget(typo, registry); } catch (err) { message = err.message; }
  assert.strictEqual(typeof message, 'string');
  assert.ok(message.indexOf('"splitter"') !== -1, message);
  assert.ok(message.indexOf('without saying so') !== -1, 'the reason: ' + message);
  assert.ok(message.indexOf('splices') !== -1, 'the fields it does read are listed: ' + message);
});

test('a case slip on a known field is refused with the real casing', function () {
  // `headend` for `headEnd`: without the guard the engine reads `design.headEnd`, finds nothing, and
  // answers "design.headEnd.model is required" - the right refusal for a missing end, the wrong one
  // for a lower-case key, and it leaves the plain object the caller sent untouched and unexplained.
  const typo = { headend: { model: 'sfp-plus-10g-lr-10km' }, cpe: { model: 'sfp-plus-10g-lr-10km' } };
  let message = '';
  try { budget.pointToPoint(typo, registry); } catch (err) { message = err.message; }
  assert.ok(message.indexOf('does not read the design field "headend"') !== -1, message);
  assert.ok(message.indexOf('did you mean "headEnd"') !== -1, message);
});

test('a prefix of a known field is refused with the full name', function () {
  // `margin` is how a caller writes a design reserve by hand; the field is `marginDb`.
  throws(function () { budget.opticalBudget(longPon({ margin: 3 }), registry); }, 'marginDb', 'the full field');
});

test('a design with an unrelated extra key still budgets, unchanged', function () {
  // A guard that refused every key it does not know would make the budget unusable for a caller
  // carrying its own metadata. Only a near miss of a field that exists is refused.
  const withMeta = budget.opticalBudget(longPon({ name: 'estate A', plantNotes: 'surveyed 2026-11' }), registry);
  const plain = budget.opticalBudget(longPon(), registry);
  close(withMeta.odnLossDb, plain.odnLossDb, 0.001, 'same loss with and without unrelated keys');
  assert.strictEqual(withMeta.verdict, plain.verdict);
});

test('the active budget refuses a typo the same way', function () {
  const typo = { headEnd: { model: 'sfp-plus-10g-lr-10km' }, cpe: { model: 'sfp-plus-10g-lr-10km' }, span: [] };
  throws(function () { budget.pointToPoint(typo, registry); }, 'spans', 'the plural');
});

// The other half of "a field the budget does not read is refused": a field it *does* read, holding a
// value it cannot use. `marginDb` and `allowanceDb` decide the verdict, so a value that is skipped or
// read literally is a verdict the caller did not ask for - in the optimistic direction, every time.
//
// 20.0 km g652d-loose-96 @ 1490 nm: 20.0 x 0.22 = 4.40; 1:64 splitter = 20.50; 10 splices x 0.10 =
// 1.00; 6 connectors x 0.30 = 1.80  ->  ODN 27.70 dB. +1.5 dBm launch - 27.70 = -26.20 dBm against
// -27 dBm sensitivity  ->  0.80 dB of headroom where the 3 dB margin is required, so `fail`.
function tightPon(overrides) {
  return Object.assign({
    olt: { model: 'gpon-b-plus-8' },
    ont: { model: 'gpon-ont-1ge' },
    wavelength: '1490',
    spans: [{ cable: 'g652d-loose-96', lengthM: 20000 }],
    splitters: [{ model: 'plc-1x64-sca' }],
    splices: 10,
    connectors: 6
  }, overrides || {});
}

test('a failing design is not talked into passing by a negative reserve', function () {
  // The baseline: -26.20 dBm is 0.80 dB above -27 dBm, and the reason names the 3 dB margin.
  const plain = budget.opticalBudget(tightPon(), registry);
  assert.strictEqual(plain.verdict, 'fail', 'baseline: ' + JSON.stringify(plain.reasons));
  // `marginDb: -5` was read straight into `headroomDb < marginDb`, so 0.80 < -5 is false and the same
  // link came back `marginal` - a reserve that is not a reserve, passing a link 2.2 dB short.
  throws(function () { budget.opticalBudget(tightPon({ marginDb: -5 }), registry); }, 'marginDb', 'a negative margin');
  // `allowanceDb: -3` is subtracted from ODN loss instead of added: total 24.70, -23.20 dBm, headroom
  // 3.80 dB, also `marginal`. A negative allowance *buys* received power, which is the one thing an
  // allowance may never do.
  throws(function () { budget.opticalBudget(tightPon({ allowanceDb: -3 }), registry); }, 'allowanceDb', 'a negative allowance');
});

test('a reserve sent as text is refused, not replaced by the default', function () {
  // `isNum('3')` is false, so `marginDb: '3'` fell back to the default 3 - right answer, by luck -
  // and `allowanceDb: '2'` fell back to 0: the caller asked for 2 dB of design allowance and was
  // budgeted without it. The refusal quotes the value as JSON, so a string reads as `"2"` and cannot
  // be mistaken for the number 2 it was meant to be.
  const text = throws(function () { budget.opticalBudget(longPon({ allowanceDb: '2' }), registry); }, 'allowanceDb', 'text allowance');
  assert.ok(text.message.indexOf('"2"') !== -1, 'the value is quoted as JSON: ' + text.message);
  assert.ok(text.message.indexOf('(a string)') !== -1, 'the cause, not just the field: ' + text.message);
  throws(function () { budget.opticalBudget(longPon({ marginDb: '3' }), registry); }, 'marginDb', 'text margin');
});

test('a reserve that is a number still budgets, zero included', function () {
  // Zero is a real answer - a lab link with no reserve - and 2 dB of allowance is 2 dB more loss, not
  // a key to ignore. 14.80 + 2.00 = 16.80 dB.
  const zero = budget.opticalBudget(longPon({ marginDb: 0 }), registry);
  assert.strictEqual(zero.marginDb, 0);
  assert.strictEqual(zero.verdict, 'ok', 'no reserve is not a failure');
  const allowance = budget.opticalBudget(longPon({ allowanceDb: 2 }), registry);
  close(allowance.totalLossDb, 16.8, 0.001, 'ODN 14.80 + 2.00 allowance');
  close(allowance.rxPowerDbm, 1.5 - 16.8, 0.001, 'receive power with the allowance spent');
});

test('a direction that is not up or down is refused, not silently read as down', function () {
  // `design.direction === 'up' ? 'up' : 'down'` answered a downstream budget to a caller who asked
  // for something else, and the two are different networks: downstream is the ONT's receiver at
  // 1490 nm, upstream is the OLT's at 1310 nm. The response did say `direction: 'down'`, but a typo
  // that a caller has to notice in the answer is a typo that reaches the plan.
  const err = throws(function () { budget.opticalBudget(longPon({ direction: 'sideways' }), registry); }, 'direction', 'a bogus direction');
  assert.ok(err.message.indexOf('"sideways"') !== -1, 'names what it got: ' + err.message);
  assert.ok(err.message.indexOf('"up"') !== -1, 'names what it accepts: ' + err.message);
  assert.strictEqual(budget.opticalBudget(longPon({ direction: 'up' }), registry).direction, 'up');
});

test('the active budget refuses the same values', function () {
  // One reader, two technologies: point-to-point computes its verdict from the same two knobs, so a
  // guard that only covered the PON path would leave the site-to-site budget exactly as wrong.
  const p2p = {
    headEnd: { model: 'sfp-1g-ex-40km' },
    cpe: { model: 'sfp-1g-ex-40km' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 30000 }],
    splices: 4,
    connectors: 2
  };
  throws(function () { budget.pointToPoint(Object.assign({}, p2p, { marginDb: -5 }), registry); }, 'marginDb', 'active negative margin');
  throws(function () { budget.pointToPoint(Object.assign({}, p2p, { allowanceDb: '2' }), registry); }, 'allowanceDb', 'active text allowance');
  throws(function () { budget.pointToPoint(Object.assign({}, p2p, { direction: 'sideways' }), registry); }, 'direction', 'active bogus direction');
});
test('a design run refuses the reserve it cannot use, instead of defaulting it', function () {
  // `/api/design/synthesise` normalises `marginDb` with the same `isNum` fallback the budget used, so
  // `'3'` became 3 by luck and `-5` reached every candidate's budget - which refused it once per
  // demand point: a four-point CSV answered 200 with twelve copies of the sentence and no `error`.
  // The field is checked where it is read, so the answer is one refusal naming `marginDb`.
  const demand = 'lat,lon\n51.5000,-0.1000\n51.5005,-0.1002';
  const opts = { headEnd: { lat: 51.499, lon: -0.101, model: 'gpon-b-plus-8' }, technology: 'pon' };
  throws(function () { engine.design.synthesise(demand, Object.assign({ marginDb: -5 }, opts), registry); }, 'marginDb', 'a synthesised design with a negative margin');
  throws(function () { engine.design.synthesise(demand, Object.assign({ marginDb: '3' }, opts), registry); }, 'marginDb', 'a synthesised design with a text margin');
  // An absent margin still defaults, and a real one still ranks: the guard refuses values, not keys.
  assert.ok(engine.design.synthesise(demand, opts, registry).candidates.length > 0);
});

test('a site-to-site link refuses the same two values', function () {
  // `engine/link.js` reads `marginDb` and `direction` through the same fallbacks and passes them into
  // `pointToPoint`, so a guard on one path and not the other leaves the DC-to-DC budget as wrong as
  // the PON one was: `direction: 'sideways'` was answered as downstream, silently.
  const linkOpts = {
    sites: { a: { lat: 51.5, lon: -0.1 }, b: { lat: 51.52, lon: -0.11 } },
    optics: { a: 'sfp-1g-ex-40km', b: 'sfp-1g-ex-40km' }
  };
  throws(function () { engine.link.design(Object.assign({ direction: 'sideways' }, linkOpts), registry); }, 'direction', 'a bogus link direction');
  throws(function () { engine.link.design(Object.assign({ marginDb: -5 }, linkOpts), registry); }, 'marginDb', 'a negative link margin');
  throws(function () { engine.link.design(Object.assign({ marginDb: '3' }, linkOpts), registry); }, 'marginDb', 'a text link margin');
});

// A launch power written inside the end object is not a field the budget reads - and it is the shape
// both doc blocks advertised (`olt { model, txDbm? }`, `headEnd { model, txDbm? }`) from 0.1.0 until
// this fix. The engine has only ever read the top-level `design.txDbm`, so a caller who followed the
// shape got the launch silently reset to the transmitter's minimum: on the 15 km B+ design below that
// is -13.30 dBm instead of -9.80 dBm, 3.50 dB optimistic, with the headroom and the pad sized for a
// module running cold. The top-level field is a real knob and stays; the nested spelling is refused so
// the number the caller wrote is either used or named.
test('a launch power inside the endpoint object is refused, not silently dropped', function () {
  // The baseline first, so the size of the drop is the assertion's own arithmetic:
  // ODN 14.80 dB from a +1.5 dBm floor  ->  -13.30 dBm  (headroom 13.70 dB against -27 dBm).
  const plain = budget.opticalBudget(longPon(), registry);
  close(plain.rxPowerDbm, 1.5 - 14.8, 0.001, 'the B+ launch floor is the default');
  // `olt.txDbm: 5` as documented would have been 5.00 - 14.80 = -9.80 dBm. It was read as absent.
  const err = throws(function () {
    budget.opticalBudget(longPon({ olt: { model: 'gpon-b-plus-8', txDbm: 5 } }), registry);
  }, 'txDbm', 'a nested launch on the OLT');
  assert.ok(err.message.indexOf('design.olt.txDbm') !== -1, 'names where it got it: ' + err.message);
  assert.ok(err.message.indexOf('"txDbm"') !== -1, 'names the field it reads instead: ' + err.message);
  // The ONT is the other end, and upstream it launches: the same guard, the same reason.
  throws(function () {
    budget.opticalBudget(longPon({ ont: { model: 'gpon-ont-1ge', txDbm: 2 } }), registry);
  }, 'txDbm', 'a nested launch on the ONT');
});

test('the top-level launch is still read, inside the window and outside it', function () {
  // 4.00 - 14.80 = -10.80 dBm: a real launch, used, not defaulted.
  const pinned = budget.opticalBudget(longPon({ txDbm: 4 }), registry);
  close(pinned.txDbm, 4, 0.001, 'the pinned launch is the launch');
  close(pinned.rxPowerDbm, 4 - 14.8, 0.001, 'receive power at the pinned launch');
  // 0 dBm is under the 1.5 dBm floor this card can make: used, with a warning naming the window, which
  // is the long-standing behaviour of this field and not part of the guard. 0.00 - 14.80 = -14.80 dBm.
  const cold = budget.opticalBudget(longPon({ txDbm: 0 }), registry);
  close(cold.txDbm, 0, 0.001, 'a launch below the window is still the launch');
  close(cold.rxPowerDbm, 0 - 14.8, 0.001, 'receive power at the launch the caller asked for');
  assert.strictEqual(cold.reasons.length, 0, JSON.stringify(cold.reasons));
  assert.ok(cold.warnings.some(function (w) { return w.indexOf('outside the OLT gpon-b-plus-8 range') !== -1; }),
    JSON.stringify(cold.warnings));
});

test('the active budget refuses a nested launch at either end', function () {
  // `sfp-plus-10g-lr-10km` launches -8.2..+0.5 dBm; 500 m of g652d-loose-24 at 1310 nm is
  // 0.5 x 0.35 = 0.175 dB, so a pinned +0.5 dBm floor reads -0.175 dBm at the far end.
  const p2p = function (ends) {
    return { headEnd: ends.headEnd, cpe: ends.cpe, spans: [{ cable: 'g652d-loose-24', lengthM: 500 }] };
  };
  const LR = { model: 'sfp-plus-10g-lr-10km' };
  const plain = budget.pointToPoint(p2p({ headEnd: LR, cpe: LR }), registry);
  close(plain.rxPowerDbm, -8.2 - 0.175, 0.01, 'the head-end launch floor, rounded to 2 places');
  throws(function () {
    budget.pointToPoint(p2p({ headEnd: { model: 'sfp-plus-10g-lr-10km', txDbm: 0.5 }, cpe: LR }), registry);
  }, 'txDbm', 'a nested launch on the head-end optic');
  throws(function () {
    budget.pointToPoint(p2p({ headEnd: LR, cpe: { model: 'sfp-plus-10g-lr-10km', txDbm: 0.5 } }), registry);
  }, 'txDbm', 'a nested launch on the customer optic');
  // Pinned at the top of the window upstream: 0.50 - 0.175 = 0.325 dBm, and the pad is sized for the
  // launch the caller pinned rather than for the module's ceiling.
  const up = budget.pointToPoint(Object.assign(p2p({ headEnd: LR, cpe: LR }), { txDbm: 0.5, direction: 'up' }), registry);
  close(up.rxPowerDbm, 0.5 - 0.175, 0.01, 'upstream at a pinned launch');
});

test('an endpoint object carrying its own metadata still budgets, unchanged', function () {
  // The guard refuses the one knob the doc block advertised, not the object: a caller that passes a
  // whole catalogue entry (vendor, class, ports and all) gets the same arithmetic it got before.
  const rich = budget.opticalBudget(longPon({
    olt: { model: 'gpon-b-plus-8', vendor: 'generic', class: 'B+', ports: 8 },
    ont: { model: 'gpon-ont-1ge', vendor: 'generic' }
  }), registry);
  const plain = budget.opticalBudget(longPon(), registry);
  close(rich.odnLossDb, plain.odnLossDb, 0.001, 'same loss with metadata on the ends');
  close(rich.rxPowerDbm, plain.rxPowerDbm, 0.001, 'same launch with metadata on the ends');
});

// The third reader: the **project** budget. The server hands a request body to `designForOnt`, which
// reads eight named keys off it, so a near miss there is the same skipped setting - and it was not
// refused at all. A body of `{ "margindb": 40 }` answered 200 with `marginDb: 3` echoed: the reserve was
// never applied and a link 30 dB short of the one the caller asked for came back `ok`.
test('the project budget refuses a near miss of a key it reads', function () {
  throws(function () { budget.assertProjectBudgetFields({ margindb: 40 }); }, 'marginDb', 'the field that was meant');
  throws(function () { budget.assertProjectBudgetFields({ ontid: 'd1-ont-d1' }); }, 'ontId', 'the narrowing key');
  throws(function () { budget.assertProjectBudgetFields({ margin: 6 }); }, 'marginDb', 'the prefix of a real field');
});

test('every key the project budget reads passes, and so does metadata', function () {
  // The refusal is narrow, so a body made only of the eight keys must pass - a guard that refused one of
  // them would refuse the endpoint correct request - and so must unrelated metadata, because a caller
  // who is not wrong is not refused.
  let error = null;
  try {
    budget.assertProjectBudgetFields({
      ontId: 'd1-ont-d1', direction: 'up', wavelength: '1310', spliceModel: 'fusion',
      connectorModel: 'sc-apc', marginDb: 4, allowanceDb: 1, txDbm: 5,
      notes: 'surveyed 2026-11-19', name: 'west estate'
    });
  } catch (err) { error = err; }
  assert.strictEqual(error, null, error ? error.message : 'an allowed key was refused');
});

// Reading the list against the reader: a key the budget reads but the guard forgot is unprotected, and a
// key the guard lists but nobody reads is a refusal nobody should trust. A case slip, a plural or a
// prefix on each of the eight is refused with the real name, so the list cannot silently shrink.
test('a slip on each of the eight project-budget keys is refused with the real name', function () {
  const slips = [
    ['ontid', 'ontId'],
    ['directions', 'direction'],
    ['wavelengths', 'wavelength'],
    ['splicemodel', 'spliceModel'],
    ['connectormodel', 'connectorModel'],
    ['margin', 'marginDb'],
    ['allowance', 'allowanceDb'],
    ['txdbm', 'txDbm']
  ];
  slips.forEach(function (pair) {
    const body = {};
    body[pair[0]] = 1;
    let message = '';
    try { budget.assertProjectBudgetFields(body); } catch (err) { message = err.message; }
    assert.ok(message.indexOf('did you mean "' + pair[1] + '"') !== -1,
      'key "' + pair[0] + '" should name ' + pair[1] + ', got: ' + (message || 'no refusal'));
  });
});

done();
