'use strict';
// A feeder is not built by bundling drop cable (gh#127).
//
// Bundling is the documented answer when a span's fibres exceed the largest rung of the ladder
// ("160 fibres over a 144-fibre ladder is two", GLOSSARY). `cableFor` answers with the largest rung
// when nothing in the ladder fits, and the builders then set `bundles = ceil(fibres / fiberCount)` -
// so a ladder whose largest rung is a *drop* cable produced a 494.8 m feeder made of six bundled
// 2-fibre drop cables, budgeted it, ranked it `ok` and put the drums on the BOM. Drop cable is the
// last leg: a span is legally on drop cable only at or below `DROP_CABLE_MAX_M` with at most two
// fibres, and beyond that the ladder has to name a cable that carries the span or the candidate is
// refused by name.
//
// `link.cableForFibres` already refuses the same shape for a circuit. This is the auto-design side.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const HEAD_END = { lat: 51.499, lon: -0.1004 };

// 40 houses on a 0.00045 deg grid (~50 m apart): the estate from the issue, deterministic.
function estate() {
  const points = [];
  for (let i = 0; i < 40; i++) {
    points.push({
      label: 'H' + i,
      lat: 51.5 + Math.floor(i / 8) * 0.00045 * 8,
      lon: -0.1 + (i % 8) * 0.00045
    });
  }
  return points;
}

test('a ladder whose largest rung is drop cable refuses the feeder by name', function () {
  const out = engine.design.synthesise(estate(), {
    headEnd: HEAD_END,
    technology: 'pon',
    ladder: ['g657a2-drop-2']
  }, registry);

  assert.strictEqual(out.best, null, 'a feeder of bundled drop cable must not be the ranked design');
  assert.ok(out.candidates.length > 0, 'the run must still report the candidates it refused');
  out.candidates.forEach(function (candidate) {
    assert.strictEqual(candidate.feasible, false, candidate.label + ' was accepted on a drop-only ladder');
    const named = candidate.reasons.filter(function (r) { return r.indexOf('drop cable') !== -1; });
    assert.ok(named.length > 0,
      candidate.label + ' refuses without naming the drop cable in the ladder: ' + candidate.reasons.join(' | '));
    // The refusal names the cable and the fibre count a span needed, so the caller knows what to add.
    assert.ok(named[0].indexOf('g657a2-drop-2') !== -1, 'the refusal must name the drop rung: ' + named[0]);
    assert.ok(/[0-9]+ fibres/.test(named[0]), 'the refusal must name the fibres the span needed: ' + named[0]);
  });
});

test('the bundling rule still works when the ladder has a distribution cable', function () {
  // 40 active terminals at two fibres each: the spans near the head end carry 74 fibres, which is
  // seven 12-fibre cables - the documented bundling case, and it must stay feasible.
  const out = engine.design.synthesise(estate(), {
    headEnd: HEAD_END,
    technology: 'active',
    ladder: ['g652d-loose-12']
  }, registry);
  assert.ok(out.best, 'a 12-fibre ladder must still design the estate');
  assert.strictEqual(out.best.feasible, true, out.best.warnings.join('; '));
  const bundled = out.plant.spans.filter(function (s) { return (s.bundles || 1) > 1; });
  assert.ok(bundled.length > 0, 'the estate must still produce a bundled span');
  bundled.forEach(function (span) {
    assert.notStrictEqual(span.cable, 'g657a2-drop-2', 'a bundled span cannot be drop cable: ' + span.id);
  });
});

test('the same estate on the default ladder is unchanged', function () {
  const out = engine.design.synthesise(estate(), { headEnd: HEAD_END, technology: 'pon' }, registry);
  assert.ok(out.best, 'the default ladder must still design the estate');
  assert.strictEqual(out.best.feasible, true, out.best.warnings.join('; '));
  // `best` carries warnings only; the candidate table is where reasons live.
  const dropReasons = out.candidates.filter(function (c) {
    return c.reasons.some(function (r) { return r.indexOf('drop cable') !== -1; });
  });
  assert.deepStrictEqual(dropReasons, [], 'a legal design must carry no drop-cable refusal');
});

test('a short two-fibre drop on a drop-only ladder is not the refusal', function () {
  // The rule is about spans that leave the drop class, not about drop cable existing: a 2-fibre
  // span at 120 m is exactly what drop cable is for.
  const short = engine.design.synthesise([
    { label: 'H1', lat: 51.5004, lon: -0.1004 },
    { label: 'H2', lat: 51.5008, lon: -0.1000 }
  ], { headEnd: HEAD_END, technology: 'active', ladder: ['g657a2-drop-2'] }, registry);
  assert.ok(short.best, 'a two-house estate on short drops must still design');
  assert.strictEqual(short.best.feasible, true, short.best.warnings.join('; '));
  short.plant.spans.forEach(function (span) {
    if (span.cable !== 'g657a2-drop-2') return;
    assert.ok(span.lengthM <= engine.design.DROP_CABLE_MAX_M,
      'drop cable on a ' + span.lengthM + ' m span is not a drop: ' + span.id);
    assert.ok((span.bundles || 1) === 1, 'drop cable was bundled on ' + span.id);
  });
});

test('a long span with only drop cable in the ladder is refused, not built as a 660 m drop', function () {
  // Two houses ~660 m apart on an active design: each span is two fibres, but 660 m of it is a cable
  // run, not a drop. The ladder names no cable for it, so the answer says so.
  const out = engine.design.synthesise([
    { label: 'H1', lat: 51.5, lon: -0.1 },
    { label: 'H2', lat: 51.5, lon: -0.094 }
  ], { headEnd: { lat: 51.5, lon: -0.1009 }, technology: 'active', ladder: ['g657a2-drop-2'] }, registry);
  if (out.best) {
    out.plant.spans.forEach(function (span) {
      if (span.cable !== 'g657a2-drop-2') return;
      assert.ok(span.lengthM <= engine.design.DROP_CABLE_MAX_M,
        'a ' + span.lengthM + ' m span was built on drop cable: ' + span.id);
    });
  } else {
    const named = out.candidates.some(function (c) {
      return c.reasons.some(function (r) { return r.indexOf('drop cable') !== -1; });
    });
    assert.ok(named, 'every candidate failed without naming drop cable as the reason');
  }
});

done();
