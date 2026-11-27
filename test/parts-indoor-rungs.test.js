'use strict';
// The 12F indoor row gave a building riser something to select; a 20-flat or 40-flat tower needs more
// than twelve fibres and had only outdoor loose tube to name. These assertions hold the two new rungs
// to their Belden sheets, and hold three things a reader of notes must be told rather than hope for:
// the sheets publish no putup (so the row has no drumM and the BOM says which default it charged), the
// 48F is four subunits of twelve (so the strands address T01..T04), and a ladder that names both an
// indoor row and its outdoor twin buys the outdoor one - model id breaks the tie, and g652d- sorts
// first.
// Figures: Belden GIMTF24 (rev 0.58) and GIMTF48 (rev 0.98) technical data sheets, both 0.40 dB/km
// max at 1310 and 0.30 max at 1550/1625; the rows carry the catalogue's typical installed 0.35/0.21.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const RUNG_24 = 'g657a2-indoor-24';
const RUNG_48 = 'g657a2-indoor-48';

function bomLines(candidate) {
  return (candidate.bom && candidate.bom.lines) || [];
}

test('the 24F and 48F rungs are the cables their sheets describe', function () {
  const twentyFour = registry.get('cable', RUNG_24);
  const fortyEight = registry.get('cable', RUNG_48);

  assert.strictEqual(twentyFour.fiberCount, 24);
  assert.strictEqual(fortyEight.fiberCount, 48);
  // GIMTF48 is four active subunits of twelve, so the strands are T01..T04, not one tube of 48.
  assert.strictEqual(fortyEight.fibersPerTube, 12, '48F is 4 x 12 subunits');
  assert.strictEqual(twentyFour.fibersPerTube, 12, '24F is two ringmarked groups of twelve');

  for (const cable of [twentyFour, fortyEight]) {
    assert.strictEqual(cable.construction, 'tight-buffer', cable.model);
    assert.strictEqual(cable.fiberStandard, 'G.657.A2', cable.model);
    assert.deepStrictEqual(cable.use, ['indoor'], cable.model + ': Dca is not a water or UV rating');
    assert.ok(/catalog\.belden\.com\/techdata/.test(cable.sourceUrl), cable.model + ' ' + cable.sourceUrl);
    assert.ok(cable.label.indexOf('GIMTF') !== -1, cable.model + ': the label names the part');
    // The sheets publish no putup and no variant table, so the row publishes no drum rather than
    // borrow the 12F row's 4,100 m reel (GIMTF12.044100, a 12F variant).
    assert.strictEqual(cable.drumM, undefined, cable.model + ' must not quote a reel nobody sells');
    // 0.40/0.30 are the sheets' maxima; the row carries the catalogue's typicals under them.
    assert.strictEqual(cable.attenuationDbPerKm['1310'], 0.35, cable.model);
    assert.strictEqual(cable.attenuationDbPerKm['1490'], 0.22, cable.model);
    assert.strictEqual(cable.attenuationDbPerKm['1550'], 0.21, cable.model);
  }
});

test('a 240 m riser on either rung budgets 0.053 dB at 1490 nm', function () {
  // 0.24 km x 0.22 dB/km = 0.0528 dB of fibre, plus nothing else.
  for (const model of [RUNG_24, RUNG_48]) {
    const out = engine.budget.opticalBudget({
      olt: { model: 'gpon-b-plus-8' },
      ont: { model: 'gpon-ont-1ge' },
      direction: 'down',
      spans: [{ cable: model, lengthM: 240 }],
      splices: 0,
      connectors: 0
    }, registry);
    close(out.odnLossDb, 0.0528, 0.001, model + ': 0.24 km x 0.22 dB/km');
    assert.strictEqual(out.wavelength, '1490', model + ': a PON is budgeted downstream at 1490 nm');
  }
});

test('a 24-fibre span buys the 24F rung and a 48-fibre span the 48F', function () {
  assert.strictEqual(engine.design.cableForSpan(24, 200, [RUNG_24], registry).model, RUNG_24);
  assert.strictEqual(engine.design.cableForSpan(48, 200, [RUNG_48], registry).model, RUNG_48);
  // 13 fibres is not a 12F riser: the ladder floor is the smallest rung that fits.
  assert.strictEqual(engine.design.cableForSpan(13, 200, [RUNG_24, RUNG_48], registry).model, RUNG_24);
});

test('named beside its outdoor twin, the indoor rung loses the tie on model id', function () {
  // Not a defect in the row - the ladder resolves on smallest fibre count and then on model id, and
  // g652d- sorts before g657a2-. notes tells the reader to name the indoor row alone; this pins the
  // behaviour so nobody adds the indoor rows to DEFAULT_LADDER expecting them to be chosen.
  assert.strictEqual(engine.design.cableForSpan(24, 200, [RUNG_24, 'g652d-loose-24'], registry).model,
    'g652d-loose-24');
  assert.strictEqual(engine.design.cableForSpan(48, 200, [RUNG_48, 'g652d-loose-48'], registry).model,
    'g652d-loose-48');
});

test('the BOM bills the rung only when the ladder names it, at the engine drum default', function () {
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

  const chosen = engine.design.synthesise(demand, Object.assign({}, opts, { ladder: [RUNG_24] }), registry);
  const line = bomLines(chosen.candidates[0]).filter(function (l) { return l.model === RUNG_24; })[0];
  assert.ok(line, 'a caller who names the indoor rung gets it');
  // The sheet publishes no putup, so the BOM charges engine/length.js's 2,000 m default and prints it.
  assert.strictEqual(line.drumM, 2000, 'the drum is the engine default, not a Belden putup');
  assert.strictEqual(line.purchaseM, 2000, 'one default drum for a 103 m riser');

  const byDefault = engine.design.synthesise(demand, opts, registry);
  for (const candidate of byDefault.candidates) {
    for (const bomLine of bomLines(candidate)) {
      assert.ok(bomLine.model !== RUNG_24 && bomLine.model !== RUNG_48,
        'the default ladder is an outdoor plant and must not bill indoor cable: ' + bomLine.model);
    }
  }
});

done();
