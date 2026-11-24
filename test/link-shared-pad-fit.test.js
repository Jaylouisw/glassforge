'use strict';
// One pad sits in both paths of a circuit, so when both directions ask for one the report names a
// single size to buy. #203 - it named the larger of the two without checking either direction could
// take it, so at a 20 dB reserve the sentence said "buy the larger, 11 dB" directly after saying no
// inline pad clears the overload point without breaking the margin.
const { test, assert } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const link = engine.link;

// 34.7 m of duct, so the ODN is 0.012 dB of fibre + 2 x 0.30 dB of connector = 0.61 dB: short enough
// that a long-reach pair is too loud in both directions at the bottom of its launch window.
const A = { name: 'DC-West', lat: 51.5000, lon: -0.1000 };
const B = { name: 'DC-East', lat: 51.5000, lon: -0.0995 };
function duct() {
  return { edges: [{ id: 'duct', coords: [{ lat: A.lat, lon: A.lon }, { lat: B.lat, lon: B.lon }] }] };
}

function circuit(optics, extra) {
  return link.design(Object.assign({
    sites: { a: A, b: B }, network: duct(), optics: optics, protection: 'single'
  }, extra || {}), registry);
}

function upstreamWarning(r) {
  const found = r.warnings.filter(function (w) { return w.indexOf('A-leg: fails upstream') === 0; });
  assert.strictEqual(found.length, 1, r.warnings.join(' | '));
  return found[0];
}

test('a pad both directions can take is named once, as the size to buy', function () {
  // ZR at A launches 0 dBm, ER at B launches -4.7 dBm over 0.61 dB of glass: the ER receiver sees
  // -0.61 dBm (overload -1) and the ZR receiver sees -5.31 dBm (overload -7). The pads are 5 dB
  // (max 12) and 11 dB (max 15), so the larger clears both and is the one to buy.
  const r = circuit({ a: 'sfp-plus-10g-zr-80km', b: 'sfp-plus-10g-er-40km' });
  const leg = r.legs[0];
  assert.strictEqual(leg.budget.attenuator.padDb, 5);
  assert.strictEqual(leg.upstream.attenuator.padDb, 11);
  const warning = upstreamWarning(r);
  assert.ok(warning.indexOf('buy the larger, 11 dB') !== -1, warning);
});

test('a pad neither direction can take is not named as a purchase', function () {
  // The same pair with a 20 dB reserve. Downstream has 15.19 dB of receiver headroom (-0.61 dBm at a
  // sensitivity of -15.8), so a 5 dB pad leaves 10.19 dB and the 20 dB reserve is already unreachable -
  // both directions answer `fits: false`, and their own reasons say a different optic is needed.
  const r = circuit({ a: 'sfp-plus-10g-zr-80km', b: 'sfp-plus-10g-er-40km' }, { marginDb: 20 });
  const leg = r.legs[0];
  assert.strictEqual(leg.budget.attenuator.fits, false, 'downstream cannot take a pad');
  assert.strictEqual(leg.upstream.attenuator.fits, false, 'upstream cannot take a pad');
  const warning = upstreamWarning(r);
  assert.ok(warning.indexOf('buy the larger') === -1, 'no size is offered as a purchase: ' + warning);
  assert.ok(warning.indexOf('No single pad clears both directions') !== -1, warning);
  assert.ok(warning.indexOf('5 dB downstream, 11 dB upstream') !== -1, warning);
  assert.ok(warning.indexOf('cannot take one at all') !== -1, warning);
});

test('a larger pad that breaks the tighter direction is not offered either', function () {
  // ER at A, ZR at B, a 5 dB reserve: downstream (ER into the ZR receiver, -4.7 - 0.61 = -5.31 dBm
  // against an overload of -7) needs 11 dB and fits up to 13; upstream (-0.61 dBm into the ER receiver)
  // needs 5 dB and fits up to 10. Each size works alone, but 11 dB leaves the upstream direction 1 dB
  // short of its reserve, so there is no single pad for both.
  const r = circuit({ a: 'sfp-plus-10g-er-40km', b: 'sfp-plus-10g-zr-80km' }, { marginDb: 5 });
  const leg = r.legs[0];
  assert.strictEqual(leg.budget.attenuator.padDb, 11);
  assert.strictEqual(leg.budget.attenuator.maxPadDb, 13);
  assert.strictEqual(leg.upstream.attenuator.padDb, 5);
  assert.strictEqual(leg.upstream.attenuator.maxPadDb, 10);
  const warning = upstreamWarning(r);
  assert.ok(warning.indexOf('buy the larger') === -1, 'no size is offered as a purchase: ' + warning);
  assert.ok(warning.indexOf('No single pad clears both directions') !== -1, warning);
  assert.ok(warning.indexOf('over the 10 dB the tighter one allows') !== -1, warning);
});
