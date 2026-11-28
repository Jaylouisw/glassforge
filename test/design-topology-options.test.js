'use strict';
// The nested design blocks are the last options that were still read rather than validated.
//
// #157 gave the top-level knobs that treatment (routeFactor, overlengthPct, maxSnapM, technology,
// ladder) because each one measures the plan. pon and active are merged in with Object.assign, so a
// shape the design cannot read is not reported - it is *replaced*, and the plant is then built from
// parts nobody asked for. Measured on this estate (8 houses, 706.3 m of design length at the default,
// one 1:8 splitter site):
//
//   pon: 'gpon'                      merged no key at all; the 1:8/16/32 default search ranked a
//                                    plant the caller never specified. 200, no note.
//   pon: { ratio: [8] }              the field is ratios, so the list was dropped and the default
//                                    search picked the split; a typo'd [32] became a 1:8 site.
//   pon: { ratios: '16' }            a string is iterated BY CHARACTER: the search tried 1:1 and
//                                    1:6 and answered "no candidate topology could be built for
//                                    technology pon" - the estate blamed for a missing bracket.
//   pon: { ratios: '8' }             one character, so it worked, which is luck rather than a read.
//   pon: { maxDropM: -5 }            no house is within -5 m of a splitter, so nothing is reachable;
//                                    it designed 8 splitter sites at 557.9 m and ranked it best -
//                                    cheaper-looking than the shared tree, and unbuildable.
//   pon: { ratios: [3] } (pon only)  a whole split with no splitter part: the search skipped it and
//                                    the refusal said only "no candidate topology could be built for
//                                    technology pon" - no ratio, no plc-1x3-sca - while the same
//                                    request under auto carried the reason in `notes`.
//   active: { optics: 'sfp-1g...' }  not a list, so the three DEFAULT pairs were searched and a
//                                    10G LR-10KM design came back as the answer.
//   active: { optics: [{}] }         each end took the default of its generation, pairing a 10G
//                                    head-end optic with the default CPE and reporting every ONT as
//                                    "the optics run at different rates" - six rows for one typo.
//
// A string is exactly what a form field arrives as and /api/design/synthesise hands its body
// straight to design.options, so an API client makes the mistake and gets a 200 or a refusal that
// names the estate. Every refusal here is a TypeError, which the endpoint maps to a 400.
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
function active(extra) {
  return design(Object.assign({ technology: 'active' }, extra));
}

test('a pon block that is not an object is refused, not merged into the defaults', function () {
  const err = throws(function () { design({ pon: 'gpon' }); }, 'pon', 'a text pon block');
  assert.ok(err instanceof TypeError, 'a client-caused refusal is a TypeError, so the endpoint answers 400');
  assert.ok(err.message.indexOf('ratios') !== -1, 'names the fields the block carries: ' + err.message);
});

test('a near-miss key inside the pon block is refused, naming the field it meant', function () {
  // ratio is one letter from ratios, so the block was accepted and the list silently dropped.
  const err = throws(function () { design({ pon: { ratio: [8] } }); }, 'ratios', 'a singular ratio key');
  assert.ok(err.message.indexOf('"ratio"') !== -1, 'quotes the key it read: ' + err.message);
});

test('a ratio list that is not a list is refused, because a string is read by character', function () {
  // 16 iterates as 1 and 6: 1:1 and 1:6 are not splitter models, so both candidates were skipped and
  // the answer was "no candidate topology could be built for technology pon".
  for (const ratios of ['16', '8', 16]) {
    const err = throws(function () { design({ pon: { ratios: ratios } }); }, 'pon.ratios',
      'ratios ' + JSON.stringify(ratios));
    assert.ok(err instanceof TypeError, 'a TypeError, so the caller is blamed and not the estate');
    assert.ok(err.message.indexOf('character') !== -1, 'says how a string would be read: ' + err.message);
  }
});

test('a ratio that is not a whole split is refused at its position', function () {
  // A splitter is 1:N with N a whole number of at least 2; 8.5 asked for plc-1x8.5-sca, which the
  // design answered as a note about a part nobody could buy, and 0 asked for plc-1x0-sca.
  const half = throws(function () { design({ pon: { ratios: [8, 8.5] } }); }, 'position 1', 'a fractional ratio');
  assert.ok(half.message.indexOf('8.5') !== -1, half.message);
  const zero = throws(function () { design({ pon: { ratios: [0] } }); }, 'position 0', 'a zero ratio');
  assert.ok(zero.message.indexOf('2') !== -1, 'names the smallest ratio a split can be: ' + zero.message);
});

test('an empty ratio list is refused, and the refusal names the default it replaces', function () {
  const err = throws(function () { design({ pon: { ratios: [] } }); }, 'pon.ratios', 'an empty ratio list');
  assert.ok(err.message.indexOf('8, 16, 32') !== -1, 'names the default the search would have used: ' + err.message);
});

test('a drop limit that is negative or arrives as text is refused', function () {
  // maxDropM -5 put every house in its own 1:1 cluster - 8 splitter sites and 557.9 m of design
  // length, ranked above the 707.3 m shared tree because the metric is what is bought.
  const negative = throws(function () { design({ pon: { maxDropM: -5 } }); }, 'maxDropM', 'a negative drop limit');
  assert.ok(negative instanceof TypeError, 'a TypeError, because the caller asked for it');
  throws(function () { design({ pon: { maxDropM: '500' } }); }, 'maxDropM', 'a text drop limit');
});

test('a pon block the design does read still designs the same plant', function () {
  // Nothing above changes a legitimate run: the same 706.3 m, one splitter site, and the splitter
  // parts are still bought from the ratio list the caller named. (706.3, not the 707.3 these two
  // lines used to pin: gh#39 stopped charging a 1 m distribution span from a splitter site to the
  // house it stands on, and this estate's first house is that medoid.)
  close(design({}).best.metrics.designM, 706.3, 0.2, 'design length at the default ratios');
  close(design({ pon: { ratios: [8], maxDropM: 500 } }).best.metrics.designM, 706.3, 0.2, 'design length at 1:8');
  assert.ok(design({ pon: { ratios: [32] } }).best.label.indexOf('1:32') !== -1,
    'a ratio the caller named is the ratio that is built: ' + design({ pon: { ratios: [32] } }).best.label);
});

test('an active block that is not an object is refused', function () {
  const err = throws(function () { active({ active: 'sfp' }); }, 'active', 'a text active block');
  assert.ok(err.message.indexOf('optics') !== -1, 'names the fields the block carries: ' + err.message);
});

test('an optics list that is not a list is refused, not replaced by the default pairs', function () {
  // Not a list, so Array.isArray failed and the design searched the three DEFAULT pairs, then
  // answered with a 10G LR-10KM plant the caller never named.
  const err = throws(function () { active({ active: { optics: 'sfp-1g-lx-10km' } }); }, 'optics',
    'a bare optic model instead of a list');
  assert.ok(err.message.indexOf('sfp-plus-10g-lr-10km') !== -1,
    'names the default optic the design would have used instead: ' + err.message);
  throws(function () { active({ active: { optics: [] } }); }, 'optics', 'an empty optics list');
});

test('an optics pair that names one end is refused at its index, naming the missing end', function () {
  // {} designed a 10G pair; { cpeOptic: 1G } paired a 1G CPE with the default 10G head-end optic and
  // reported every ONT as "the optics run at different rates" - a refusal that blames the estate.
  const empty = throws(function () { active({ active: { optics: [{}] } }); }, 'position 0', 'an empty pair');
  assert.ok(empty.message.indexOf('headEndOptic') !== -1, 'names the end it needs: ' + empty.message);
  const oneEnd = throws(function () { active({ active: { optics: [{ cpeOptic: 'sfp-1g-lx-10km' }] } }); },
    'headEndOptic', 'a pair with only a CPE optic');
  assert.ok(oneEnd.message.indexOf('different rates') !== -1,
    'says what the design would have reported instead: ' + oneEnd.message);
  const otherEnd = throws(function () { active({ active: { optics: [{ headEndOptic: 'sfp-1g-lx-10km' }] } }); },
    'cpeOptic', 'a pair with only a head-end optic');
  assert.ok(otherEnd.message.indexOf('position 0') !== -1, 'says which entry: ' + otherEnd.message);
});

test('an optics entry that is not an object is refused at its position', function () {
  const err = throws(function () { active({ active: { optics: [17] } }); }, 'position 0', 'a numeric pair');
  assert.ok(err.message.indexOf('17') !== -1, 'quotes the entry it read: ' + err.message);
});

test('a valid optics pair still designs, and the callers pair is the one built', function () {
  const out = active({ active: { optics: [{ headEndOptic: 'sfp-1g-lx-10km', cpeOptic: 'sfp-1g-lx-10km' }] } });
  assert.strictEqual(out.best.settings.headEndOptic, 'sfp-1g-lx-10km');
  assert.strictEqual(out.best.settings.optic, 'sfp-1g-lx-10km');
  close(out.best.metrics.designM, 541.4, 0.2, 'design length over the shared tree');
});

test('a block the run does not read is not refused, because it is not a setting', function () {
  // A caller that sends one form with both blocks always is not wrong: only the block the chosen
  // technology reads is validated. The unused one is neither read nor repaired.
  assert.ok(active({ pon: { ratios: '16' } }).ok, 'a pon block beside technology active is unread');
  assert.ok(design({ technology: 'pon', active: { optics: 'nope' } }).ok,
    'an active block beside technology pon is unread');
  // ...and "auto" reads both blocks, so the same block is refused when the search may use it.
  throws(function () { design({ technology: 'auto', active: { optics: 'nope' } }); }, 'active.optics',
    'an active block under technology auto');
});

test('a ratio the catalogue has no splitter for is refused by name, not by blaming the estate', function () {
  // 1:3 is a legal split - whole, at least 2 - so the option guards above pass it; the search then
  // skips it because there is no `plc-1x3-sca` part. With nothing else to build, the refusal said
  // only `no candidate topology could be built for technology "pon"`, while the same request under
  // `auto` had already written `PON 1:3 skipped: no splitter part "plc-1x3-sca" in the catalogue`
  // into `notes`: the cause known and thrown away. A ratio is the caller's input, so this is a
  // TypeError (a 400 at the endpoint) naming the ratio, the part looked up and the rungs that exist.
  const err = throws(function () { design({ technology: 'pon', pon: { ratios: [3] } }); },
    'plc-1x3-sca', 'a PON at a ratio with no splitter part');
  assert.ok(err instanceof TypeError, 'a TypeError, so the caller is blamed and not the estate');
  assert.ok(err.message.indexOf('1:3') !== -1, 'names the ratio it could not build: ' + err.message);
  // The tail is the catalogue's, sorted as everything else sorts it, so the first eight rungs are
  // the 128/16/2/32 sizes; the point is that a rung that exists is named beside the one that does not.
  assert.ok(err.message.indexOf('plc-1x16-sca') !== -1,
    'names a splitter part the catalogue does have: ' + err.message);
  assert.ok(err.message.indexOf('no candidate topology could be built') === 0,
    'keeps the sentence callers already match on, in front: ' + err.message);
});

test('one unbuildable ratio beside a buildable one is a note, not a refusal', function () {
  // `pon.ratios` is a search list, so a rung the catalogue lacks costs that candidate and nothing
  // else: the 1:8 plant is still designed, and the skip is named for the caller.
  const mixed = design({ technology: 'pon', pon: { ratios: [3, 8] } });
  assert.ok(mixed.best && mixed.best.label.indexOf('1:8') !== -1,
    'the buildable ratio is the one built: ' + (mixed.best && mixed.best.label));
  assert.ok(mixed.notes.some(function (n) { return n.indexOf('plc-1x3-sca') !== -1; }),
    'the skipped ratio is named in notes: ' + JSON.stringify(mixed.notes));
  // And `auto` still falls through to the active topologies with the same note, as it always has.
  const auto = design({ pon: { ratios: [3] } });
  assert.ok(auto.ok && auto.candidates.length, 'auto still finds a design');
  assert.ok(auto.notes.some(function (n) { return n.indexOf('PON 1:3 skipped') !== -1; }),
    'auto keeps the skip note: ' + JSON.stringify(auto.notes));
});

done();
