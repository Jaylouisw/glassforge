'use strict';
// A design option that is present and unusable is refused, not defaulted.
//
// #147 gave the budget's knobs that treatment (`marginDb`, `allowanceDb`, `direction`) because each
// one decides a verdict. The knobs that *measure* the plan were left on the old
// `isNum(x) ? x : default` fallback, and every one of them moves a length or a crew count in the
// optimistic direction when it is ignored:
//
//   routeFactor: '1.6'      fell back to 1.2. The 8-house estate below designed at 706.3 m of route
//                           where 1.6 gives 938.8 m - 232 m of duct absent from the plan.
//   overlengthPct: '10'     fell back to 3%. The same estate quoted 706.3 m of design length where
//                           10% gives 754.3 m.
//   technology: 'PON'       matched neither branch, so every candidate list was empty and the answer
//                           was "no candidate topology could be built" - a typo blamed on the estate.
//   splicesPerJoint: '2'    (link) fell back to the fibre count: a 24-fibre joint billed as 24
//                           splices the crew does not make.
//
// A string is exactly what a form field arrives as, and `/api/design/synthesise` hands its body
// straight to `design.options`, so an API client makes the mistake and got a 200.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

/** Eight houses in a line, all within a few hundred metres of the head-end. */
function estate(n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({ label: 'House ' + (i + 1), lat: 51.5 + i * 0.0004, lon: -0.1 + Math.sin(i / 5) * 0.0004 });
  }
  return points;
}
const NEAR = { lat: 51.499, lon: -0.1006, name: 'PoP' };

function design(extra) {
  return engine.design.synthesise(estate(8), Object.assign({ headEnd: NEAR }, extra), registry);
}

test('a route factor that arrives as text is refused, naming the field', function () {
  const err = throws(function () { design({ routeFactor: '1.6' }); }, 'routeFactor', 'a text route factor');
  assert.ok(err instanceof TypeError, 'a client-caused refusal is a TypeError, so the endpoint answers 400');
  assert.ok(err.message.indexOf('1.2') !== -1, 'names the default it would have silently used: ' + err.message);
});

test('a route factor below 1 is refused, because a route is never shorter than the crow flies', function () {
  throws(function () { design({ routeFactor: 0.9 }); }, 'crow flies', 'a sub-1 route factor');
});

test('the same estate at routeFactor 1.6 is 232 m longer than the default plan', function () {
  // Straight-line routing x the factor, then contracted between branch points: 706.3 m at the 1.2
  // default, 938.8 m at 1.6. Pinned so a silently-defaulted factor has to disagree with the geometry.
  // 1 m lower than the 707.3 m this used to pin, and the difference is the splitter site's stub span:
  // the site is a demand point, so the tree's first edge measured 0 m and was priced as a 1 m run (#39).
  // It is one closure, not a run, so no cable is bought for it.
  close(design({}).best.metrics.designM, 706.3, 0.2, 'design length at routeFactor 1.2');
  close(design({ routeFactor: 1.6 }).best.metrics.designM, 938.8, 0.2, 'design length at routeFactor 1.6');
});

test('an overlength that arrives as text is refused, and a number is used', function () {
  throws(function () { design({ overlengthPct: '10' }); }, 'overlengthPct', 'a text overlength');
  // 706.3 x 1.10 / 1.03 = 754.3: the design length carries the overlength, so the fallback to 3%
  // hid 48.1 m of cable on a 690 m estate.
  close(design({ overlengthPct: 10 }).best.metrics.designM, 754.3, 0.2, 'design length at 10% overlength');
});

test('a snap radius or join tolerance that arrives as text is refused', function () {
  throws(function () { design({ maxSnapM: '5' }); }, 'maxSnapM', 'a text snap radius');
  throws(function () { design({ joinToleranceM: '0.5' }); }, 'joinToleranceM', 'a text join tolerance');
});

test('a technology it cannot place is refused, naming the three it accepts', function () {
  const err = throws(function () { design({ technology: 'PON' }); }, 'technology', 'a mis-cased technology');
  assert.ok(err.message.indexOf('"auto"') !== -1 && err.message.indexOf('"pon"') !== -1 &&
    err.message.indexOf('"active"') !== -1, 'names every accepted value: ' + err.message);
  // The lower-case value still pins the search to one technology.
  const pon = design({ technology: 'pon' });
  pon.candidates.forEach(function (c) {
    assert.strictEqual(c.technology, 'pon', 'technology "pon" returned a ' + c.technology + ' candidate');
  });
});

test('an absent option is still absent - the documented default applies and is reported', function () {
  // The guard fires on a *present* value only: omitting the knobs is how every existing caller works.
  const plain = design({});
  assert.strictEqual(plain.best.feasible, true, JSON.stringify(plain.best.warnings));
  close(plain.best.metrics.designM, 706.3, 0.2, 'default design length');
});

test('a ladder that arrives as one model name is refused, not read as the default ladder', function () {
  // #157 took `isNum(x) ? x : default` off the measuring knobs; `ladder` kept it. A single string is
  // not an array, so it fell back to DEFAULT_LADDER: the estate bought five trunk spans on
  // g652d-loose-12 where the caller named g652d-loose-48 - the same 686.7 m of cable, but 5,890.2
  // fibre-metres instead of 22,569, which is the number the objective ranks on. A value that is not
  // a list of names is caller input, so it is refused by name.
  const err = throws(function () { design({ ladder: 'g652d-loose-48' }); }, 'ladder', 'a single-model ladder');
  assert.ok(err.message.indexOf('"g652d-loose-48"') !== -1, 'says the value it got: ' + err.message);
});

test('a ladder naming a cable the catalogue does not have is refused, naming the ones it has', function () {
  // Today `cableFor` throws only once a span asks for the missing cable, and its sentence names no
  // field: "the cable ladder names no cable this catalogue has: g652d-nope". The caller has to guess
  // that `ladder` is the field, and an unused bad entry in a ladder that still fits is never noticed.
  const err = throws(function () { design({ ladder: ['g652d-loose-48', 'g652d-nope'] }); }, 'ladder',
    'a ladder with an unknown cable');
  assert.ok(err.message.indexOf('"g652d-nope"') !== -1, 'names the model it does not have: ' + err.message);
  assert.ok(err.message.indexOf('g652d-loose-96') !== -1, 'names a model the catalogue does have: ' + err.message);
});

test('a ladder entry that is not a model name is refused at its position', function () {
  const err = throws(function () { design({ ladder: ['g652d-loose-48', 48] }); }, 'ladder', 'a numeric ladder entry');
  assert.ok(err.message.indexOf('position 1') !== -1, 'says which entry: ' + err.message);
});

test('an absent or empty ladder takes the default ladder, and the notes say so', function () {
  // The default is legitimate - every caller that omits `ladder` gets it - but a BOM bought from a
  // ladder the design picked has to say which ladder that was, or the number cannot be checked.
  for (const extra of [{}, { ladder: [] }]) {
    const out = design(extra);
    const notes = out.notes.filter(function (n) { return n.indexOf('default cable ladder') !== -1; });
    assert.strictEqual(notes.length, 1, JSON.stringify(out.notes));
    assert.ok(notes[0].indexOf('g652d-loose-144') !== -1 && notes[0].indexOf('g657a2-drop-2') !== -1,
      'names the ladder it used: ' + notes[0]);
  }
});

// --- the link design's own knobs -------------------------------------------------------------

const A = { lat: 51.5, lon: -0.1, name: 'Site A' };
const B = { lat: 51.62, lon: -0.1, name: 'Site B' };
const ER = { a: 'sfp-plus-10g-er-40km', b: 'sfp-plus-10g-er-40km' };

function link(extra) {
  return engine.link.design(Object.assign({ sites: { a: A, b: B }, optics: ER, protection: 'single' }, extra), registry);
}

test('a money-bearing link option that arrives as text is refused', function () {
  // 16,012 m at the 1.2 default, 18,681 m at 1.4: a leg 2.7 km short of what the caller asked for.
  close(link({}).legs[0].ownM, 16012.09, 0.5, 'leg at routeFactor 1.2');
  close(link({ routeFactor: 1.4 }).legs[0].ownM, 18680.77, 0.5, 'leg at routeFactor 1.4');
  throws(function () { link({ routeFactor: '1.4' }); }, 'routeFactor', 'a text route factor');
  throws(function () { link({ overlengthPct: '10' }); }, 'overlengthPct', 'a text overlength');
});

test('a splices-per-joint that arrives as text is refused rather than read as the fibre count', function () {
  const err = throws(function () { link({ splicesPerJoint: '2' }); }, 'splicesPerJoint', 'a text joint count');
  assert.ok(err.message.indexOf('24') !== -1, 'names the count it would have billed: ' + err.message);
  // A whole count is still read as itself: the crew count follows it.
  const jointed = link({ splicesPerJoint: 1, splices: 3 });
  assert.strictEqual(jointed.legs[0].splices, 3, 'three splice events at one splice each');
});

test('the link BOM carries a numeric overlength, and a text one never reaches it', function () {
  // 16,492.45 m at the cable default, 17,613.30 m at 10%: 1,120 m of cable the fallback hid.
  close(link({}).bom.designM, 16492.45, 0.5, 'BOM design length at the default overlength');
  close(link({ overlengthPct: 10 }).bom.designM, 17613.3, 0.5, 'BOM design length at 10%');
});

done();
