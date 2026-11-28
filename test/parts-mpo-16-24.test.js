'use strict';
// The multi-fibre APC catalogue stopped at 12 positions, while the 800G row that shipped on
// 2026-11-28 (osfp-800g-dr8-500m) is specified on an MPO-16/APC receptacle by two of its four
// vendor sheets - so its note had to tell the caller to budget an "MPO-12 pair, whichever the
// module has". SENKO's MPO-PLUS 702/712 sheet publishes the rows those positions need: single-mode
// APC 16-fibre low loss 0.15 / 0.35, 24-fibre low loss 0.15 / 0.35 and 24-fibre standard 0.25 / 1.00.
// It also prints N/A where a standard-grade 16-fibre single-mode figure would go, which is why this
// catalogue has no `mpo-16-apc` row: the figure does not exist to copy.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const budget = engine.budget;
const DR8 = { model: 'osfp-800g-dr8-500m' };

function p2p(connectorModel) {
  return budget.pointToPoint({
    headEnd: DR8,
    cpe: DR8,
    spans: [{ cable: 'g652d-loose-24', lengthM: 500 }],
    connectors: { model: connectorModel, count: 2 },
    marginDb: 3
  }, registry);
}

test('the 16- and 24-fibre APC rows carry the sheet\'s two figures, and there is no standard 16F', function () {
  const ll16 = registry.get('connector', 'mpo-16-apc-lowloss');
  assert.strictEqual(ll16.lossDb, 0.15, 'singlemode APC 16-fibre low loss, typical');
  assert.strictEqual(ll16.maxLossDb, 0.35, 'singlemode APC 16-fibre low loss, maximum');
  assert.strictEqual(ll16.polish, 'apc');
  assert.strictEqual(registry.has('connector', 'mpo-16-apc'), false,
    'the sheet prints N/A for a standard-grade 16F single-mode row; a part there would be invented');

  const ll24 = registry.get('connector', 'mpo-24-apc-lowloss');
  assert.strictEqual(ll24.lossDb, 0.15, 'singlemode APC 24-fibre low loss, typical');
  assert.strictEqual(ll24.maxLossDb, 0.35);

  const std24 = registry.get('connector', 'mpo-24-apc');
  assert.strictEqual(std24.lossDb, 0.25, 'singlemode APC 24-fibre standard, typical');
  assert.strictEqual(std24.maxLossDb, 1.0, '1.00 dB maximum: 0.65 dB above the low-loss ceiling');
  for (const part of [ll16, ll24, std24]) {
    assert.ok(/^https:\/\//.test(part.sourceUrl), part.model + ' ' + part.sourceUrl);
  }
});

test('the 16F ferrule budgets the DR8 leg 0.10 dB better than the 12F pair it replaced', function () {
  // 500 m x 0.35 dB/km = 0.175 dB of fibre.
  // 16F low loss: 2 x 0.15 = 0.30 -> ODN 0.475, headroom 3.0 - 0.475 = 2.525 -> 2.53.
  const with16 = p2p('mpo-16-apc-lowloss');
  assert.strictEqual(with16.odnLossDb, 0.475);
  assert.strictEqual(with16.headroomDb, 2.53);
  assert.strictEqual(with16.verdict, 'fail', 'the 3.0 dB DR8 class is still under a 3 dB margin');

  // 12F standard: 2 x 0.20 = 0.40 -> ODN 0.575, headroom 2.425 -> 2.43.
  const with12 = p2p('mpo-12-apc');
  assert.strictEqual(with12.odnLossDb, 0.575);
  assert.strictEqual(with12.headroomDb, 2.43);
});

test('24F standard loss spends 0.2 dB more of the budget than either low-loss row', function () {
  // 0.175 + 2 x 0.25 = 0.675 dB ODN, headroom 3.0 - 0.675 = 2.325 -> 2.33.
  const std = p2p('mpo-24-apc');
  assert.strictEqual(std.odnLossDb, 0.675);
  assert.strictEqual(std.headroomDb, 2.33);
});

done();
