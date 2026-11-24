'use strict';
// The arithmetic a design is approved on. Every expected number is derived by hand in the comment
// above it, so a change to the engine has to disagree with arithmetic rather than with an old run.
const { test, assert, throws, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;

function design(overrides) {
  return Object.assign({
    olt: { model: 'gpon-c-plus-8' },
    ont: { model: 'gpon-ont-4ge' },
    wavelength: '1490',
    spans: [{ cable: 'g652d-loose-24', lengthM: 3000 }],
    splitters: [{ model: 'plc-1x8-sca' }],
    splices: 4,
    connectors: 2
  }, overrides || {});
}

test('a healthy GPON C+ design lands where the arithmetic says', function () {
  const r = budget.opticalBudget(design(), registry);
  // fibre 3.0 km x 0.22 = 0.66; splices 4 x 0.1 = 0.40; connectors 2 x 0.3 = 0.60;
  // splitter 9.03 + 1.47 excess = 10.50  ->  ODN 12.16 dB
  close(r.odnLossDb, 12.16, 0.001, 'ODN loss');
  close(r.rxPowerDbm, -9.16, 0.001, 'receive power (3.0 dBm Tx)');
  close(r.headroomDb, 20.84, 0.001, 'headroom above -30 dBm sensitivity');
  close(r.classHeadroomDb, 32 - 12.16, 0.001, 'class headroom');
  assert.strictEqual(r.verdict, 'ok');
  assert.strictEqual(r.reasons.length, 0);
  assert.strictEqual(r.breakdown.filter(function (b) { return b.kind === 'fibre'; }).length, 1);
});

test('upstream is a different wavelength through the same glass', function () {
  const down = budget.opticalBudget(design(), registry);
  const up = budget.opticalBudget(design({ direction: 'up', wavelength: undefined }), registry);
  assert.strictEqual(up.wavelength, '1310', 'upstream defaults to 1310 nm');
  // 3.0 km x 0.35 = 1.05 instead of 0.66 -> ODN 12.55 dB, and the OLT transmitter is the receiver now
  assert.ok(up.odnLossDb > down.odnLossDb, '1310 nm attenuates more than 1490 nm in G.652.D');
  close(up.odnLossDb, 12.55, 0.001, 'upstream ODN loss');
  // The C+ OLT receiver is -32 dBm (G.984.2 Amd 2, Table V.1), not the -30 this line asserted while
  // the row carried the class B+ receiver pair: at -30 an ONU launching +0.5 dBm reaches 30.5 dB, so
  // a legal 32 dB C+ ODN read as a headroom failure on a row that declared the 32 dB class.
  assert.strictEqual(up.sensitivityDbm, -32, 'in the upstream direction the C+ OLT line card is the receiver');
});

test('a design with too little margin fails and says which margin', function () {
  // 20 km of 0.22 = 4.40 dB, 1:64 splitter = 20.50, 10 splices = 1.00, 6 connectors = 1.80 -> 27.70
  const r = budget.opticalBudget({
    olt: { model: 'gpon-b-plus-8' },
    ont: { model: 'gpon-ont-1ge' },
    wavelength: '1490',
    spans: [{ cable: 'g652d-loose-96', lengthM: 20000 }],
    splitters: [{ model: 'plc-1x64-sca' }],
    splices: 10,
    connectors: 6
  }, registry);
  // Tx 1.5 - 27.70 = -26.20 dBm against -27 dBm sensitivity -> 0.80 dB of headroom
  close(r.rxPowerDbm, -26.2, 0.001, 'receive power');
  close(r.headroomDb, 0.8, 0.001, 'headroom');
  assert.strictEqual(r.verdict, 'fail');
  assert.ok(r.reasons.some(function (x) { return x.indexOf('design margin') !== -1; }), r.reasons.join(' | '));
  assert.strictEqual(r.ok, false);
});

test('the class budget can fail a link the receiver tolerance accepts', function () {
  // The two verdicts are independent, and this is the case that proves it: 26 km at 0.35 = 9.10,
  // 1:64 = 20.50, 20 splices = 2.00, 3 connectors = 0.90 -> 32.50 dB ODN.
  // Rx = 3 - 32.50 = -29.50 dBm, which clears the -30 dBm sensitivity by 0.50 dB (no margin asked
  // for), but C+ budget is 32 dB, so the class is what refuses the design.
  const r = budget.opticalBudget({
    olt: { model: 'gpon-c-plus-8' },
    ont: { model: 'gpon-ont-4ge' },
    wavelength: '1310',
    marginDb: 0,
    spans: [{ cable: 'g652d-loose-48', lengthM: 26000 }],
    splitters: [{ model: 'plc-1x64-sca' }],
    splices: 20,
    connectors: 3
  }, registry);
  close(r.odnLossDb, 32.5, 0.001, 'ODN loss');
  assert.ok(r.headroomDb > 0, 'the receiver still hears it: headroom is ' + r.headroomDb);
  assert.ok(r.classHeadroomDb < 0, 'C+ allows 32 dB, this design is over');
  assert.ok(r.reasons.some(function (x) { return x.indexOf('budget of 32 dB') !== -1; }), r.reasons.join(' | '));
  assert.strictEqual(r.reasons.length, 1, 'the class budget is the only reason: ' + r.reasons.join(' | '));
  assert.strictEqual(r.verdict, 'fail');
});

test('a marginal design is called marginal, not ok', function () {
  const r = budget.opticalBudget(design({ marginDb: 20 }), registry);
  assert.strictEqual(r.verdict, 'marginal');
  assert.strictEqual(r.ok, true, 'marginal still builds, it just needs a decision');
});

test('the splitter cascade counts against the OLT limit', function () {
  const r = budget.opticalBudget(design({
    splitters: [{ model: 'plc-1x64-sca' }, { model: 'plc-1x8-sca' }]
  }), registry);
  assert.strictEqual(r.cascadeRatio, 512);
  assert.ok(r.reasons.some(function (x) { return x.indexOf('cascade') !== -1; }), r.reasons.join(' | '));
});

test('a cable that does not publish the window is an error, not a zero', function () {
  // A part that publishes 1310 and 1490 but not 1550. The engine must refuse the budget rather than
  // treat the missing figure as free glass.
  const parts = require('../engine/parts');
  const loaded = parts.loadSpecs();
  const partial = loaded.specs.concat([{
    kind: 'cable', model: 'partial-cable', label: 'Partial', fiberCount: 12,
    attenuationDbPerKm: { 1310: 0.35, 1490: 0.22 }, sourceUrl: 'https://example.invalid/partial'
  }]);
  const narrow = new parts.Registry(partial);
  throws(function () {
    budget.opticalBudget(design({ wavelength: '1550', spans: [{ cable: 'partial-cable', lengthM: 100 }] }), narrow);
  }, 'publishes no attenuation', 'a 1550 nm budget against a cable with no 1550 figure');
  // and the same part is fine at a window it does publish
  const ok = budget.opticalBudget(design({ wavelength: '1490', spans: [{ cable: 'partial-cable', lengthM: 1000 }] }), narrow);
  assert.strictEqual(ok.verdict, 'ok');
});

test('an unknown wavelength is refused', function () {
  throws(function () { budget.opticalBudget(design({ wavelength: '1625' }), registry); }, 'unknown wavelength');
});

test('a GPON OLT and an XGS-PON ONT cannot share a PON', function () {
  throws(function () {
    budget.opticalBudget(design({ ont: { model: 'xgs-pon-ont-1xge' } }), registry);
  }, 'cannot share a PON');
});

test('a transmit power outside the part\'s range is a warning, not a silent clamp', function () {
  const r = budget.opticalBudget(design({ txDbm: 12 }), registry);
  assert.ok(r.warnings.some(function (w) { return w.indexOf('outside') !== -1; }), r.warnings.join(' | '));
  close(r.rxPowerDbm, 12 - 12.16, 0.001, 'receive power with the requested transmit power');
});

test('a link that is too loud says which pad fixes it, and how much pad fits', function () {
  // A C++ OLT at +9 dBm - inside its +6..+10 dBm range - patched into an ONT through 5 m of drop cable: 5 m x 0.22 dB/km =
  // 0.0011 dB, so the ONT sees 9.00 dBm against an overload point of -8 dBm - 17.00 dB too loud.
  // Pads are sold in whole dB, so 17.00 dB of overload needs a 17 dB pad.
  const loud = budget.opticalBudget({
    olt: { model: 'gpon-c-plus-plus-16' },
    ont: { model: 'gpon-ont-1ge' },
    wavelength: '1490',
    spans: [{ cable: 'g657a2-drop-1', lengthM: 5 }],
    txDbm: 9,
    splitters: [],
    splices: 0,
    connectors: 0
  }, registry);
  assert.ok(loud.attenuator, 'an overloaded budget reports the pad');
  close(loud.attenuator.overDb, 17, 0.01, 'how far above the overload point');
  assert.strictEqual(loud.attenuator.padDb, 17, 'a 17 dB pad');
  // The pad is ODN loss, so it spends the same budget the route spends. Headroom is 9 - (-27) = 36 dB,
  // less the 3 dB margin = 33; the class budget is 35 - 0.0011 = 34.99 dB. The tighter of the two wins
  // and a pad is a whole number, so 34.99 dB of class headroom funds 34 dB but the margin caps it at 33.
  assert.strictEqual(loud.attenuator.maxPadDb, 33, 'the most pad the margin and class budget allow');
  assert.strictEqual(loud.attenuator.fits, true);
  assert.ok(loud.reasons.some(function (x) { return x.indexOf('fit a 17 dB inline pad') !== -1; }), loud.reasons.join(' | '));

  // The worked example is quiet: -9.16 dBm at the ONT, so there is no pad to buy. "0 dB" would be a
  // plate somebody orders.
  const healthy = budget.opticalBudget(design(), registry);
  assert.strictEqual(healthy.attenuator, null, 'a healthy link needs no pad');
});

test('when no pad can fix a too-loud design, the refusal says so instead of naming one', function () {
  // 24.05 dB of headroom against a 26 dB margin: -1.95 dB to spare, so every pad that clears the
  // +1 dBm overload point would break the margin. The design is contradictory, not under-attenuated.
  const r = budget.pointToPoint({
    headEnd: { model: 'sfp-1g-ex-40km' }, cpe: { model: 'sfp-1g-ex-40km' }, txDbm: 3, marginDb: 26,
    spans: [{ cable: 'g652d-loose-12', lengthM: 1000 }], splices: 0, connectors: 2
  }, registry);
  assert.strictEqual(r.attenuator.fits, false);
  assert.ok(r.attenuator.maxPadDb < r.attenuator.padDb, 'no whole-dB pad satisfies both limits');
  assert.ok(r.reasons.some(function (x) { return x.indexOf('no inline pad clears the overload point') !== -1; }), r.reasons.join(' | '));
});

test('overload is caught: too much power is a failure too', function () {
  const r = budget.opticalBudget({
    olt: { model: 'gpon-c-plus-plus-16' },
    ont: { model: 'gpon-ont-1ge' },
    wavelength: '1490',
    spans: [{ cable: 'g657a2-drop-1', lengthM: 5 }],
    txDbm: 9,
    splitters: [],
    splices: 0,
    connectors: 0
  }, registry);
  assert.ok(r.reasons.some(function (x) { return x.indexOf('overload') !== -1; }), r.reasons.join(' | '));
  assert.strictEqual(r.verdict, 'fail');
});

done();
