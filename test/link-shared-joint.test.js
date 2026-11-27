'use strict';
// A protected pair is edge-disjoint or it is not; but "no duct shared" is not the same claim as
// "diverse". Two legs that meet in one chamber fail together when that chamber is dug up, and the
// metres say 0. This suite pins the joint report (`diversity.sharedNodes`) and the sentence that
// carries it.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const link = engine.link;

function p(lat, lon) { return { lat: lat, lon: lon }; }

const A = { name: 'DC-West', lat: 51.5000, lon: -0.1020 };
const B = { name: 'DC-East', lat: 51.5000, lon: -0.0960 };
const M = p(51.5000, -0.0990);
const ER = { a: 'sfp-plus-10g-er-40km', b: 'sfp-plus-10g-er-40km' };

// A figure of eight: two approaches to one chamber M and two ways out of it. The two legs are
// edge-disjoint (upper in, upper out / lower in, lower out) and share the chamber and nothing else.
function figureOfEight() {
  return { edges: [
    { id: 'a-upper', coords: [p(51.5000, -0.1020), p(51.5005, -0.1010), M] },
    { id: 'a-lower', coords: [p(51.5000, -0.1020), p(51.4995, -0.1010), M] },
    { id: 'b-upper', coords: [M, p(51.5005, -0.0970), p(51.5000, -0.0960)] },
    { id: 'b-lower', coords: [M, p(51.4995, -0.0970), p(51.5000, -0.0960)] }
  ] };
}

// One corridor to a side street that leaves it at M: the pair shares the approach to M and the
// chamber, so the sentence has to carry both the metres and the joint.
function corridorAndSide() {
  return { edges: [
    { id: 'main', coords: [p(51.5000, -0.1020), p(51.5000, -0.0960)] },
    { id: 'side-a', coords: [M, p(51.4980, -0.0990)] },
    { id: 'side-b', coords: [p(51.4980, -0.0990), p(51.5000, -0.0960)] }
  ] };
}

function linkOn(network) {
  return link.design({ sites: { a: A, b: B }, network: network, optics: ER }, registry);
}

test('two edge-disjoint legs through one chamber are reported as not diverse', function () {
  const r = linkOn(figureOfEight());
  // 0 m of shared duct: every edge belongs to exactly one leg.
  assert.strictEqual(r.diversity.sharedM, 0);
  assert.strictEqual(r.diversity.shared.length, 0);
  const a = new Set(r.paths[0].edges);
  const b = new Set(r.paths[1].edges);
  for (const edgeId of a) assert.ok(!b.has(edgeId), edgeId + ' is on both legs');
  assert.strictEqual(r.diversity.method, 'suurballe');
  // But both legs turn at M (51.500000,-0.099000), so one excavation there takes out the pair.
  assert.strictEqual(r.diversity.sharedNodeCount, 1);
  assert.strictEqual(r.diversity.sharedNodes.length, 1);
  close(r.diversity.sharedNodes[0].lat, 51.5, 1e-6, 'shared joint latitude');
  close(r.diversity.sharedNodes[0].lon, -0.099, 1e-6, 'shared joint longitude');
  assert.strictEqual(r.diversity.achieved, false);
  assert.strictEqual(r.protection.achieved, false);
  assert.ok(r.diversity.sentence.indexOf('no duct is shared, but both legs pass through 1 shared joint node') === 0,
    r.diversity.sentence);
  assert.ok(r.diversity.sentence.indexOf('51.500000,-0.099000') !== -1, r.diversity.sentence);
  assert.ok(r.diversity.sentence.indexOf('takes out both legs') !== -1, r.diversity.sentence);
  assert.ok(r.warnings.some(function (w) { return w.indexOf('protection was requested but the legs are not diverse') === 0; }),
    r.warnings.join(' | '));
});

test('a shared joint is named beside the shared metres, not instead of them', function () {
  const r = linkOn(corridorAndSide());
  // Less than a full corridor: the second leg leaves the main duct at M, so it shares the western
  // half (207.7 m of 415.3 m) and the chamber M.
  close(r.diversity.sharedM, 207.66, 0.5, 'shared metres');
  assert.ok(r.diversity.sharedM > 0, 'the approach to the chamber is shared duct');
  assert.strictEqual(r.diversity.sharedNodeCount, 1);
  assert.ok(r.diversity.sentence.indexOf('diverse except ') === 0, r.diversity.sentence);
  assert.ok(r.diversity.sentence.indexOf('207.66 m across 1 shared segment(s)') !== -1, r.diversity.sentence);
  assert.ok(r.diversity.sentence.indexOf(', and both legs pass through 1 shared joint node') !== -1,
    r.diversity.sentence);
});

test('a ring has no interior joint to report, and the two sites are not joints', function () {
  const ring = { edges: [
    { id: 'AB', coords: [p(51.5, -0.1), p(51.5, -0.099)] },
    { id: 'BC', coords: [p(51.5, -0.099), p(51.509, -0.099)] },
    { id: 'CD', coords: [p(51.509, -0.099), p(51.509, -0.1)] },
    { id: 'DA', coords: [p(51.509, -0.1), p(51.5, -0.1)] }
  ] };
  const r = link.design({ sites: { a: { name: 'N', lat: 51.5, lon: -0.1 }, b: { name: 'S', lat: 51.509, lon: -0.099 } },
    network: ring, optics: ER }, registry);
  // Both legs start at N and end at S, so the two sites are shared by definition; reporting them
  // would refuse every circuit. Only interior vertices count.
  assert.deepStrictEqual(r.diversity.sharedNodes, []);
  assert.strictEqual(r.diversity.sharedNodeCount, 0);
  assert.strictEqual(r.diversity.achieved, true);
  assert.ok(r.diversity.sentence.indexOf('0 m shared') !== -1, r.diversity.sentence);
});

test('a pair that shares the whole corridor reports no joint, only the metres', function () {
  const corridor = { edges: [{ id: 'duct', coords: [p(51.5, -0.1020), p(51.5, -0.0960)] }] };
  const r = link.design({ sites: { a: A, b: B }, network: corridor, optics: ER }, registry);
  // Two legs over one duct: every metre is shared, and the only vertices on it are the two sites,
  // which are excluded. A joint list here would be the terminals with a new name.
  assert.strictEqual(r.diversity.legs, 2);
  assert.strictEqual(r.diversity.sharedM, 415.32);
  assert.deepStrictEqual(r.diversity.sharedNodes, []);
  assert.strictEqual(r.diversity.sharedNodeCount, 0);
  assert.strictEqual(r.diversity.achieved, false);
  assert.ok(r.diversity.sentence.indexOf('diverse except 415.32') === 0, r.diversity.sentence);
});
