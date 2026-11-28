'use strict';
// The project list's route length and the plant's own route length are one number with two
// spellings: `GET /api/projects` reads `summary.routeM`, the project page reads `stats.routeM`.
// A hand-edited file can carry a span length as text, and the two used to disagree by three orders
// of magnitude: `n + "100"` is `"0100"`, so two 100 m spans answered 100100 m.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

function plant(spans) {
  const p = engine.project.createProject('Route length', { id: 'proute', now: '2026-01-01T00:00:00.000Z' });
  p.nodes = [
    { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'POP', lat: 51.5, lon: -0.1 },
    { id: 'n2', type: 'closure', model: 'nap-8', name: 'NAP', lat: 51.5005, lon: -0.1 },
    { id: 'n3', type: 'ont', model: 'gpon-ont-1ge', name: 'H1', lat: 51.501, lon: -0.1 }
  ];
  p.spans = spans;
  return p;
}

function span(id, lengthM) {
  return { id: id, from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: lengthM };
}

test('two measured spans add up to their sum of metres', function () {
  const p = plant([span('s1', 100), span('s2', 100)]);
  // 100 + 100 = 200 m - the control: the arithmetic this suite is about.
  assert.strictEqual(engine.project.summary(p, registry).routeM, 200);
  assert.strictEqual(engine.network.stats(p, registry).routeM, 200);
});

test('a span whose length is text is not counted, and neither surface invents metres', function () {
  // A project file edited by hand, or a span written by a tool that stringified the number. The
  // answer used to be 100100: JavaScript's `+` concatenated the string onto the running sum.
  const p = plant([span('s1', '100'), span('s2', '100')]);
  const summary = engine.project.summary(p, registry);
  const stats = engine.network.stats(p, registry);
  assert.strictEqual(summary.routeM, 0, 'a text length is not a length: got ' + summary.routeM);
  assert.strictEqual(summary.routeM, stats.routeM, 'the summary and the plant must quote one number');
  // The plant does not hide it either: the same two spans are named by the validator.
  const check = engine.project.check(p, registry);
  assert.strictEqual(check.ok, false);
  assert.ok(check.errors.join(' ').indexOf('span "s1" has no measured length') !== -1, check.errors.join(' | '));
});

test('a length that is not finite is not counted, and the summary stays a finite number', function () {
  // `NaN` cannot come through JSON, but it can come through an in-memory plant, and `Infinity`
  // through neither - tested anyway, because the rule is the value, not the transport.
  const p = plant([span('s1', NaN), span('s2', Infinity), span('s3', 250)]);
  const summary = engine.project.summary(p, registry);
  assert.strictEqual(summary.routeM, 250, 'only the measured span counts: got ' + summary.routeM);
  assert.strictEqual(typeof summary.routeM, 'number');
  assert.ok(isFinite(summary.routeM));
  assert.strictEqual(summary.routeM, engine.network.stats(p, registry).routeM);
});

test('a null entry among the spans does not break the route length', function () {
  // `network.validate` names the null; the summary is built for the same project and must not throw
  // (it answers `GET /api/projects` after all).
  const p = plant([span('s1', 100), null, span('s3', 50)]);
  assert.strictEqual(engine.project.summary(p, registry).routeM, 150);
});

done();
