'use strict';
// The design's clustering pass count is an option, and it was the one entry in
// `DESIGN_OPTION_FIELDS` the design never read: `kmeansIterations: 1` passed the key guard and every
// call still ran the 8-pass default, so the knob narrowed nothing. The guard beside it says in so
// many words that "a design option the engine ignores does not narrow or widen anything" - this one
// did exactly that while being spelled correctly, which no near-miss check can see.
//
// It moves real numbers. Measured on thirteen houses on an L (eight down the north-south street,
// five along the east-west one, the head end at the corner): one pass leaves the 1:8 candidate on
// 4 splitter sites and 14,812.2 fibre-metres, the 8-pass default on 2 sites and 13,555. Different
// plants, different ranking - so the count is the caller's, not a constant.
//
// And a value the loop cannot use is refused rather than run: with `maxIterations: 0` the assignment
// pass never runs, `clusterPoints` answers no clusters, and the candidate comes back with 0 ONT,
// 0 spans and `feasible: true` - a design that reaches nobody, ranked first on 0 fibre-metres.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

/** Thirteen houses on an L, with the head end at the corner. */
const L_SHAPE = (function () {
  const points = [];
  for (let i = 1; i <= 8; i++) points.push({ id: 'v' + i, label: 'V' + i, lat: 52 + i * 0.0009, lon: 4 });
  for (let i = 1; i <= 5; i++) points.push({ id: 'h' + i, label: 'H' + i, lat: 52, lon: 4 + i * 0.0009 });
  return points;
})();
const HEAD_END = { lat: 52, lon: 4, name: 'HE' };

function design(extra) {
  return engine.design.synthesise(L_SHAPE, Object.assign({ headEnd: HEAD_END, technology: 'pon' }, extra), registry);
}

/** The 1:8 candidate, whichever ratio the ranking prefers. */
function eight(out) {
  return out.candidates.filter(function (c) { return c.label.indexOf('PON 1:8') === 0; })[0];
}

test('one pass is one pass: the caller\'s count clusters the estate, it is not a constant', function () {
  // One pass leaves the four corner houses in their initial clusters: 4 splitter sites, 14,812.2
  // fibre-metres. Two or more passes move the medoids and contract the estate onto 2 sites,
  // 13,555 fibre-metres. Both figures are this fixture's geometry, not a snapshot of a default.
  const one = eight(design({ kmeansIterations: 1 }));
  const eightPasses = eight(design({ kmeansIterations: 8 }));
  assert.strictEqual(one.metrics.splitters, 4, 'one pass: four initial clusters survive');
  close(one.metrics.fibreMetres, 14812.2, 0.5, 'one pass of fibre-metres');
  assert.strictEqual(eightPasses.metrics.splitters, 2, 'eight passes: the medoids move');
  close(eightPasses.metrics.fibreMetres, 13555, 0.5, 'eight passes of fibre-metres');
});

test('zero passes is refused: it builds a plant with no ONT and ranks it feasible', function () {
  // Measured before the guard, on this fixture: every candidate came back
  // `{ onts: 0, spans: 0, fibreMetres: 0, feasible: true }` and the 1:8 one won the ranking.
  [0, -1].forEach(function (bad) {
    const err = throws(function () { design({ kmeansIterations: bad }); }, 'kmeansIterations',
      'a pass count of ' + bad);
    assert.ok(err instanceof TypeError, 'a client-caused refusal is a TypeError, so the endpoint answers 400');
    assert.ok(err.message.indexOf('no ONT') !== -1, 'names the plant it would have ranked: ' + err.message);
  });
});

test('a pass count that is not a whole number is refused, naming the field', function () {
  // The loop runs `iteration < maxIterations`, so 1.5 silently means two passes - a count nobody
  // chose. A string is what a form field arrives as, and 1.5 is a half-remembered number.
  ['3', 1.5, null, true].forEach(function (bad) {
    const err = throws(function () { design({ kmeansIterations: bad }); }, 'kmeansIterations',
      'a pass count of ' + String(bad));
    assert.ok(err instanceof TypeError, 'a client-caused refusal is a TypeError, so the endpoint answers 400');
  });
});

test('an absent pass count keeps the documented default, and the answer still ranks', function () {
  // Omitting the option is not a mistake, and it is the same 8 passes as before the option was read.
  const out = design({});
  assert.strictEqual(eight(out).metrics.splitters, 2, 'the default is still the converged clustering');
  assert.ok(out.best && out.best.feasible, 'the default design still ranks a winner');
});

done();
