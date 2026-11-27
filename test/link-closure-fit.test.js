'use strict';
// The link BOM orders a closure per joint, and until now the `closure` option was never looked up:
// an unknown model was echoed into `bom.closures` with the design `ok`, and a closure too small for
// the splices made in it was billed silently. Both are the same question — is the thing on the
// purchase order a part that exists and can hold the joint? — asked where the BOM is built.
const { test, assert, throws, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const link = engine.link;

function p(lat, lon) { return { lat: lat, lon: lon }; }

const A = { name: 'DC-West', lat: 51.5000, lon: -0.1020 };
const B = { name: 'DC-East', lat: 51.5000, lon: -0.0960 };
const M = p(51.5000, -0.0990);
const ER = { a: 'sfp-plus-10g-er-40km', b: 'sfp-plus-10g-er-40km' };

// Two edge-disjoint legs through one chamber M: one interior joint on each leg, so the BOM orders
// two closures (one per leg's splice site) and every closure carries `splicesPerJoint` splices.
function figureOfEight() {
  return { edges: [
    { id: 'a-upper', coords: [p(51.5000, -0.1020), p(51.5005, -0.1010), M] },
    { id: 'a-lower', coords: [p(51.5000, -0.1020), p(51.4995, -0.1010), M] },
    { id: 'b-upper', coords: [M, p(51.5005, -0.0970), p(51.5000, -0.0960)] },
    { id: 'b-lower', coords: [M, p(51.4995, -0.0970), p(51.5000, -0.0960)] }
  ] };
}

test('a closure model the catalogue does not have is refused by name, not echoed into the BOM', function () {
  const thrown = throws(function () {
    link.design({ sites: { a: A, b: B }, network: figureOfEight(), optics: ER, closure: 'mufa-inline-99' }, registry);
  }, 'mufa-inline-99', 'an unknown closure model');
  // The message names the models that exist, the same rule as an unknown cable or optic.
  assert.ok(thrown.message.indexOf('mufa-inline-24') !== -1, thrown.message);
});

test('a closure too small for the splices at its joint is warned about, naming one that fits', function () {
  // 48 fibres per leg through one joint each: 48 splices in a 24-splice mufa. Verdict stays as the
  // budget gives it (the plant treats capacity as a warning, not an error), but the BOM cannot be
  // ordered without someone noticing.
  const r = link.design({ sites: { a: A, b: B }, network: figureOfEight(), optics: ER, fibres: 48 }, registry);
  assert.strictEqual(r.bom.closures.model, 'mufa-inline-24');
  assert.strictEqual(r.bom.closures.count, 2);
  const capacityWarning = r.warnings.filter(function (w) { return w.indexOf('would carry 48 splices') !== -1; });
  assert.strictEqual(capacityWarning.length, 1, r.warnings.join(' | '));
  assert.ok(capacityWarning[0].indexOf('capacity 24') !== -1, capacityWarning[0]);
  assert.ok(capacityWarning[0].indexOf('fosc-600c-inline-216') !== -1,
    'the warning must name a closure that holds 48 splices: ' + capacityWarning[0]);
});

test('a closure that fits, and a design with no joint, raise nothing', function () {
  // 2 splices in a 24-splice mufa: the default is the part that fits, so silence.
  const small = link.design({ sites: { a: A, b: B }, network: figureOfEight(), optics: ER }, registry);
  assert.strictEqual(small.warnings.filter(function (w) { return w.indexOf('would carry') !== -1; }).length, 0,
    small.warnings.join(' | '));
  // A 504-splice closure carries a 48-fibre joint.
  const big = link.design({ sites: { a: A, b: B }, network: figureOfEight(), optics: ER, fibres: 48,
    closure: 'fosc-600d-inline-504' }, registry);
  assert.strictEqual(big.warnings.filter(function (w) { return w.indexOf('would carry') !== -1; }).length, 0,
    big.warnings.join(' | '));
  // No graph: one straight-line leg with no interior joint buys no closure, so a small default is
  // not a defect there and must not be warned about.
  const straight = link.design({ sites: { a: A, b: B }, optics: ER, fibres: 48 }, registry);
  assert.strictEqual(straight.bom.closures.count, 0);
  assert.strictEqual(straight.warnings.filter(function (w) { return w.indexOf('would carry') !== -1; }).length, 0,
    straight.warnings.join(' | '));
});

done();
