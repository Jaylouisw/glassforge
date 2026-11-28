'use strict';
// A site-to-site link is two optics and fibre. A splitter is a PON element, so a circuit cannot
// contain one - and a request that names one has to be refused rather than budgeted around it.
//
// The budget learned this in gh#169/#170: `budget.pointToPoint` refuses a design carrying
// `splitters`, because charging 10.50 dB of insertion loss to a link nobody can pull makes the
// verdict blame the route for a part the route cannot have. The LINK was left out of that fix for a
// reason that turns out to be the defect: `link.design` builds each leg's design itself and never
// hands the caller's `splitters` to the budget, so the budget's guard could not see it. The key was
// not on `LINK_OPTION_FIELDS` either, so the near-miss guard called it "not a key at all" and the
// request answered 200.
//
// Measured on main at 5443234, A(51.50,-0.10) to B(51.51,-0.10) on 10G-LR optics, straight line:
//
//   {"sites":{...},"splitters":[{"model":"plc-1x8-sca"}]}
//     -> 200, ok: true, leg ODN loss 1.067 dB (0.467 fibre + 0.60 connectors), cable BOM 1374.37 m
//
// The 10.50 dB part is in neither the loss nor the bill, and the `ok` reads as "this circuit
// lights". Refused by name now, pointing at the budget that may charge a splitter.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const link = engine.link;

const A = { name: 'DC-West', lat: 51.5000, lon: -0.1020 };
const B = { name: 'DC-East', lat: 51.5000, lon: -0.0960 };
const LR = { a: 'sfp-plus-10g-lr-10km', b: 'sfp-plus-10g-lr-10km' };

function body(extra) {
  return Object.assign({ sites: { a: A, b: B }, optics: LR }, extra || {});
}

// ------------------------------------------------------------------ refused by name

test('a link design carrying splitters is refused, not priced', function () {
  const err = throws(function () {
    link.design(body({ splitters: [{ model: 'plc-1x8-sca' }] }), registry);
  }, 'splitters', 'link.design with a splitter list');
  assert.ok(/PON/.test(err.message), 'the refusal should say a splitter is a PON element: ' + err.message);
  assert.ok(err.message.indexOf('plc-1x8-sca') !== -1,
    'the refusal should name the splitter part it refused: ' + err.message);
});

test('the singular key is refused as the near miss it is, naming "splitters"', function () {
  // `splitter` is one keystroke from `splitters`; the near-miss guard names the field meant rather
  // than leaving a splitter out of the circuit the caller described.
  const err = throws(function () {
    link.design(body({ splitter: { model: 'plc-1x8-sca' } }), registry);
  }, 'splitters', 'link.design with a singular splitter');
  assert.ok(/did you mean "splitters"/.test(err.message), err.message);
});

test('a splitters value that is not a list is refused by the same rule', function () {
  const err = throws(function () {
    link.design(body({ splitters: 'plc-1x8-sca' }), registry);
  }, 'splitters', 'link.design with splitters as a bare model name');
  assert.ok(err.message.indexOf('plc-1x8-sca') !== -1, err.message);
});

// ------------------------------------------------------------------ "none" is not a splitter

test('an empty splitters list is "none", and the link still designs', function () {
  const r = link.design(body({ splitters: [] }), registry);
  assert.strictEqual(r.ok, true);
  // Straight line A->B = 0.006 deg of longitude at 51.5 = 415.3 m x routeFactor 1.2 = 498.4 m;
  // 498.4 m x 0.35 dB/km = 0.174 dB, plus 2 x 0.30 dB sc-apc connectors = 0.774 dB.
  close(r.legs[0].budget.odnLossDb, 0.774, 0.01, 'ODN loss with no splitter charged');
  assert.strictEqual(r.legs[0].budget.cascadeRatio, 1);
});

test('the same key on the PON budget is charged, which is where the refusal sends the caller', function () {
  // The loss is real. The PON budget defaults to 1490 nm downstream, so 498.4 m x 0.22 dB/km = 0.11;
  // + 2 x 0.30 sc-apc connectors = 0.60; + 10.50 for plc-1x8-sca (9.03 split + 1.47 excess) = 11.21 dB.
  // The link refuses the part; the PON budget charges it.
  const pon = engine.budget.opticalBudget({
    olt: { model: 'gpon-b-plus-8' },
    ont: { model: 'gpon-ont-4ge' },
    spans: [{ cable: 'g652d-loose-12', lengthM: 498.4 }],
    connectors: 2,
    splitters: [{ model: 'plc-1x8-sca' }]
  }, registry);
  close(pon.odnLossDb, 11.21, 0.01, 'PON ODN loss with one 1:8');
  assert.strictEqual(pon.cascadeRatio, 8);
});

test('a link with no body is still refused by the missing sites, not by this guard', function () {
  const err = throws(function () { link.design(undefined, registry); }, 'sites.a', 'link.design with no body');
  assert.ok(!/Cannot read propert/.test(err.message), 'the refusal must be a sentence: ' + err.message);
});

done();
