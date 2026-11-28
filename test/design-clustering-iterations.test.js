'use strict';
// `kmeansIterations` was the one key in the design's accepted option list that no code read.
//
// `DESIGN_OPTION_FIELDS` names it, so a caller's `{ kmeansIterations: 1 }` passed the near-miss guard,
// and `options()` returned the 8-pass default unconditionally. A correct spelling that changes nothing
// is the one mistake a near-miss check cannot see: the guard beside it exists precisely because "a
// design option the engine ignores does not narrow or widen anything".
//
// Thirteen houses on an L - eight down the north-south street, five along the east-west one, the head
// end at the corner - designed at 1:8:
//
//   eight passes (default)   2 splitter sites   the default clustering
//   one pass                 4 splitter sites   a different plant, a different ranking on fibre-metres
//
// The knob is not cosmetic; it was simply not wired. Wiring it also exposes the other half: with zero
// passes the loop never assigns a house to a site, `clusterPoints` answers no clusters, and every PON
// candidate comes back with no ONT on it - which then wins the ranking on 0 fibre-metres. A pass count
// the loop cannot use is therefore refused by name, not run.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const HEAD_END = { lat: 51.5, lon: -0.1, name: 'Corner PoP' };

/**
 * Thirteen properties on an L: eight up the north-south street, five along the east-west one. A grid
 * of two arms rather than a blob, so the number of cluster sites actually depends on how many
 * assignment passes the loop runs.
 */
const STEP = 0.0009; // ~100 m of latitude per house on the north arm

function lEstate() {
  const points = [];
  for (let i = 1; i <= 8; i++) {
    points.push({ label: 'North ' + i, lat: 51.5 + i * STEP, lon: -0.1 });
  }
  for (let j = 1; j <= 5; j++) {
    points.push({ label: 'East ' + j, lat: 51.5, lon: -0.1 + j * STEP * 2 });
  }
  return points;
}

function design(extra) {
  return engine.design.synthesise(lEstate(), Object.assign({ headEnd: HEAD_END, technology: 'pon' }, extra),
    registry);
}

function ratioCandidate(result, ratio) {
  const prefix = 'PON 1:' + ratio + ' ';
  const found = result.candidates.filter(function (c) {
    return c.technology === 'pon' && c.label.indexOf(prefix) === 0;
  });
  assert.strictEqual(found.length, 1, 'expected exactly one PON 1:' + ratio + ' candidate');
  return found[0];
}

function splitterSites(candidate) {
  // The candidate table drops the plant unless `includeAllPlants` asks for it; the metrics are the
  // row the report and the ranking are read from, so the count is taken there.
  return candidate.metrics.splitters;
}

function refusal(extra) {
  try {
    design(extra);
  } catch (err) {
    return err;
  }
  return null;
}

test('the default is still eight passes, so every existing design is unchanged', function () {
  const implicit = design({});
  const explicit = design({ kmeansIterations: 8 });
  close(implicit.best.metrics.fibreMetres, explicit.best.metrics.fibreMetres, 0.05,
    'the 8-pass default and an explicit 8 are the same design');
});

test('one clustering pass is read, and it builds a different 1:8 plant', function () {
  const eight = ratioCandidate(design({}), 8);
  const one = ratioCandidate(design({ kmeansIterations: 1 }), 8);
  // One pass assigns every house against the seed centres once and never re-centres them, so the
  // two-arm estate settles on more, smaller sites than the converged default. Measured on this
  // engine for the geometry pinned above; the numbers are what one pass actually produces, so a
  // silently-defaulted value has to disagree with this measurement rather than with history.
  //   8 passes: 2 splitter sites, 18,939.3 fibre-metres
  //   1 pass:   4 splitter sites, 18,714.0 fibre-metres
  assert.strictEqual(splitterSites(eight), 2, 'the 8-pass default clusters the L into 2 sites');
  assert.strictEqual(splitterSites(one), 4,
    'kmeansIterations: 1 must change the plant, not be silently defaulted to 8');
  close(eight.metrics.fibreMetres, 18939.3, 0.2, '8-pass fibre-metres');
  close(one.metrics.fibreMetres, 18714.0, 0.2, '1-pass fibre-metres');
  assert.strictEqual(one.metrics.onts, 13, 'every house is still served at one pass');
});

test('zero passes is refused, naming the no-ONT plant it would rank', function () {
  const err = refusal({ kmeansIterations: 0 });
  assert.ok(err instanceof TypeError, 'a client-caused refusal is a TypeError, so the endpoint answers 400');
  assert.ok(err.message.indexOf('kmeansIterations') !== -1, 'names the field: ' + err.message);
  assert.ok(/no ONT|nobody|no house/i.test(err.message), 'names the consequence: ' + err.message);
});

test('a negative pass count is refused the same way', function () {
  const err = refusal({ kmeansIterations: -1 });
  assert.ok(err instanceof TypeError, 'a negative count is a client error');
  assert.ok(err.message.indexOf('kmeansIterations') !== -1, 'names the field: ' + err.message);
});

test('a pass count that is not a whole number is refused', function () {
  const err = refusal({ kmeansIterations: 1.5 });
  assert.ok(err instanceof TypeError, 'half a pass is a client error');
  assert.ok(err.message.indexOf('kmeansIterations') !== -1, 'names the field: ' + err.message);
});

test('a pass count that arrives as text, null or a boolean is refused', function () {
  ['3', null, true].forEach(function (value) {
    const err = refusal({ kmeansIterations: value });
    assert.ok(err instanceof TypeError, 'kmeansIterations: ' + JSON.stringify(value) + ' must be refused');
    assert.ok(err.message.indexOf('kmeansIterations') !== -1,
      'names the field for ' + JSON.stringify(value) + ': ' + err.message);
    assert.ok(err.message.indexOf('8') !== -1,
      'names the default it would have run: ' + err.message);
  });
});

done();
