'use strict';
// A design option that is present and unusable is refused, not defaulted.
//
// #147 gave the budget's knobs that treatment (`marginDb`, `allowanceDb`, `direction`) because each
// one decides a verdict. The knobs that *measure* the plan were left on the old
// `isNum(x) ? x : default` fallback, and every one of them moves a length or a crew count in the
// optimistic direction when it is ignored:
//
//   routeFactor: '1.6'      fell back to 1.2. The 8-house estate below designed at 707.3 m of route
//                           where 1.6 gives 939.8 m - 232 m of duct absent from the plan.
//   overlengthPct: '10'     fell back to 3%. The same estate quoted 707.3 m of design length where
//                           10% gives 755.4 m.
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
  // Straight-line routing x the factor, then contracted between branch points: 707.3 m at the 1.2
  // default, 939.8 m at 1.6. Pinned so a silently-defaulted factor has to disagree with the geometry.
  close(design({}).best.metrics.designM, 707.3, 0.2, 'design length at routeFactor 1.2');
  close(design({ routeFactor: 1.6 }).best.metrics.designM, 939.8, 0.2, 'design length at routeFactor 1.6');
});

test('an overlength that arrives as text is refused, and a number is used', function () {
  throws(function () { design({ overlengthPct: '10' }); }, 'overlengthPct', 'a text overlength');
  // 707.3 x 1.10 / 1.03 = 755.4: the design length carries the overlength, so the fallback to 3%
  // hid 48.1 m of cable on a 690 m estate.
  close(design({ overlengthPct: 10 }).best.metrics.designM, 755.4, 0.2, 'design length at 10% overlength');
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
  close(plain.best.metrics.designM, 707.3, 0.2, 'default design length');
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
