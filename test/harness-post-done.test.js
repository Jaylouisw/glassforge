'use strict';
// A suite that registers a test after `done()` used to print `FAIL ...` and then a green summary:
// `done()` had already printed its totals, and the exit hook refuses to print a second line, so the
// runner tallied `N passed, 0 failed` while the console showed the failure (issue #75).
//
// Harness behaviour can only be observed by ending a process, so each case here is a child suite.
const path = require('path');
const { spawnSync } = require('child_process');
const { test, assert, done } = require('./harness');

const ROOT = path.join(__dirname, '..');
const HARNESS = JSON.stringify(path.join(__dirname, 'harness.js'));

function runSuite(lines) {
  // cwd is the repo root so a relative require from a suite would behave as it does in the runner.
  const res = spawnSync(process.execPath, ['-e', lines.join('\n')], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const summaries = out.match(/\d+ passed, \d+ failed/g) || [];
  return {
    status: res.status,
    out: out,
    summaries: summaries,
    // scripts/run-tests.js tallies the LAST summary line, so that is the one under test.
    summary: summaries.length ? summaries[summaries.length - 1] : null
  };
}

const PRELUDE = 'const h = require(' + HARNESS + ');';

test('a failure registered after done() is scored, so the last summary line says 1 failed', function () {
  const r = runSuite([
    PRELUDE,
    "h.test('a passing case', function () {});",
    'h.done();',
    "h.test('a case appended after done()', function () { throw new Error('boom'); });"
  ]);
  // 1 passing case + the placement failure: the runner reads `1 passed, 1 failed`, not `1 passed, 0 failed`.
  assert.strictEqual(r.summary, '1 passed, 1 failed', 'last summary line was ' + r.summary);
  assert.notStrictEqual(r.status, 0, 'a post-done failure must exit non-zero, got ' + r.status);
  assert.ok(r.out.indexOf('registered after done()') !== -1,
    'the failure does not name the placement, so the suite author cannot find it');
});

test('a test that would pass after done() is still a failure, because it cannot count', function () {
  const r = runSuite([
    PRELUDE,
    "h.test('a passing case', function () {});",
    'h.done();',
    "h.test('a passing case appended after done()', function () {});"
  ]);
  // Uncounted is not passed: a summary printed before a test ran describes a suite that never had it.
  assert.strictEqual(r.summary, '1 passed, 1 failed', 'last summary line was ' + r.summary);
  assert.notStrictEqual(r.status, 0, 'a test registered after done() must exit non-zero, got ' + r.status);
});

test('a well-ordered suite still prints exactly one summary and exits zero', function () {
  const r = runSuite([
    PRELUDE,
    "h.test('a passing case', function () {});",
    "h.test('another passing case', function () {});",
    'h.done();'
  ]);
  assert.strictEqual(r.summaries.length, 1, 'expected one summary line, got ' + r.summaries.length);
  assert.strictEqual(r.summary, '2 passed, 0 failed');
  assert.strictEqual(r.status, 0);
});

test('a suite that forgets done() is still reported by the exit hook', function () {
  const r = runSuite([
    PRELUDE,
    "h.test('a passing case', function () {});"
  ]);
  assert.strictEqual(r.summary, '1 passed, 0 failed', 'silence used to look like a clean pass');
  assert.strictEqual(r.status, 0);
});

done();
