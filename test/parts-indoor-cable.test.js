'use strict';
// `use` has documented `indoor` since the schema was written and no part carried it, so a building
// riser had nothing to select: the only 12F on the shelf was loose-tube, which is an outdoor cable
// and the wrong one to pull down a shaft. These assertions hold the row to its datasheet and hold the
// one property that would silently break if somebody later added indoor cable to the default ladder:
// an auto-designed outdoor plant must never be billed for it.
// Figures: Belden GIMTF12 technical data sheet (0.40 dB/km max at 1310, 0.30 max at 1550).
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const INDOOR = 'g657a2-indoor-12';

function bomCables(candidate) {
  const models = [];
  for (const line of (candidate.bom && candidate.bom.lines) || []) {
    if (line.model) models.push(line.model);
  }
  return models;
}

test('the indoor row is the cable its datasheet describes', function () {
  const cable = registry.get('cable', INDOOR);
  assert.strictEqual(cable.fiberCount, 12, 'twelve fibres - the floor cableForSpan applies to a non-drop span');
  assert.strictEqual(cable.construction, 'tight-buffer', 'GIMTF12 is a tight-buffered distribution cable');
  assert.strictEqual(cable.fiberStandard, 'G.657.A2', 'the datasheet grades the fibre G.657A2');
  assert.deepStrictEqual(cable.use, ['indoor'], 'indoor only - a Dca reaction-to-fire class is not a water or UV rating');
  assert.strictEqual(cable.drumM, 4100, 'the variant this row prices is a 4,100 m reel (GIMTF12.044100)');
  assert.strictEqual(cable.attenuationDbPerKm['1490'], 0.22, '1490 nm is the PON downstream window and must publish a figure');
});

test('a 200 m riser budgets at the row\'s own attenuation', function () {
  // 0.2 km x 0.22 dB/km = 0.044 dB of fibre at 1490 nm, plus nothing else
  const out = engine.budget.opticalBudget({
    olt: { model: 'gpon-b-plus-8' },
    ont: { model: 'gpon-ont-1ge' },
    direction: 'down',
    spans: [{ cable: INDOOR, lengthM: 200 }],
    splices: 0,
    connectors: 0
  }, registry);
  assert.strictEqual(out.odnLossDb, 0.044, '0.2 km x 0.22 dB/km');
  assert.strictEqual(out.wavelength, '1490', 'a PON is budgeted downstream at 1490 nm');
});

test('an indoor cable reaches the BOM only when the ladder names it', function () {
  const demand = [
    { id: 'a', lat: 51.5009, lon: -0.1, model: 'gpon-ont-1ge' },
    { id: 'b', lat: 51.5011, lon: -0.0999, model: 'gpon-ont-1ge' }
  ];
  const opts = {
    technology: 'pon',
    routeFactor: 1,
    headEnd: { id: 'he', lat: 51.5, lon: -0.1 },
    pon: { ratios: [8], olt: 'gpon-b-plus-8', ont: 'gpon-ont-1ge' }
  };

  const chosen = engine.design.synthesise(demand, Object.assign({}, opts, { ladder: [INDOOR] }), registry);
  assert.ok(bomCables(chosen.candidates[0]).indexOf(INDOOR) !== -1,
    'a caller who names the indoor cable gets it: ' + bomCables(chosen.candidates[0]).join(','));

  const byDefault = engine.design.synthesise(demand, opts, registry);
  for (const candidate of byDefault.candidates) {
    assert.ok(bomCables(candidate).indexOf(INDOOR) === -1,
      'the default ladder is an outdoor plant and must not bill indoor cable: ' + bomCables(candidate).join(','));
  }
});

done();
