'use strict';
/**
 * A test harness small enough to read in one sitting, and honest about what it counted.
 *
 * Every suite is a standalone Node script that prints `<n> passed, <m> failed` and exits non-zero
 * on failure - `scripts/run-tests.js` aggregates those lines, and `npm test` runs the runner. No
 * framework, because the project has no dependencies and a test runner is not worth one.
 */

const assert = require('assert');

const state = { passed: 0, failed: 0, failures: [] };

let reported = false;
let ended = false;

/** Print the summary once, however the suite ends. */
function report() {
  if (reported) return;
  reported = true;
  console.log(state.passed + ' passed, ' + state.failed + ' failed');
  if (state.failed) process.exitCode = 1;
}

function test(name, fn) {
  if (ended) {
    // `done()` has already printed the totals, so this case can never appear in them. Running it
    // still gives the diagnostic, but it is scored as a failure either way: a suite that appends a
    // test after `done()` used to print `FAIL ...` above a green summary, and the runner reads the
    // summary line, so the failure vanished (issue #75). Re-print the totals so the last summary
    // line - the one the runner tallies - is the true one.
    let error = null;
    try {
      fn();
    } catch (err) {
      error = err;
    }
    state.failed++;
    state.failures.push({
      name: name,
      error: error || new Error('test registered after done()')
    });
    console.error(
      'FAIL ' + name + '\n      test registered after done(): the summary was already printed, ' +
      'so this case cannot count as a pass' +
      (error ? '\n      it also threw: ' + (error && error.message ? error.message : error) : '')
    );
    reported = false;
    report();
    return;
  }
  try {
    fn();
    state.passed++;
  } catch (err) {
    state.failed++;
    state.failures.push({ name: name, error: err });
    console.error('FAIL ' + name + '\n      ' + (err && err.message ? err.message : err));
  }
}

/** Assert that `fn` throws, and that the message contains `needle`. */
function throws(fn, needle, label) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, (label || 'call') + ' should have thrown');
  if (needle) {
    assert.ok(
      String(threw.message).indexOf(needle) !== -1,
      (label || 'call') + ' threw "' + threw.message + '", expected it to mention "' + needle + '"'
    );
  }
  return threw;
}

function close(actual, expected, tolerance, label) {
  const t = tolerance === undefined ? 0.01 : tolerance;
  assert.ok(
    Math.abs(actual - expected) <= t,
    (label || 'value') + ': expected ' + expected + ' +/- ' + t + ', got ' + actual
  );
}

// The reason this is a hook rather than only a `done()` call: a suite that forgets to call `done()`
// used to print nothing at all, and `scripts/run-tests.js` reads the summary line to count. Silence
// there looks like a suite that ran and passed with zero assertions - the worst possible outcome for
// a check. Hooking `exit` means every suite reports, including one that dies half way through.
process.on('exit', report);

function done() {
  ended = true;
  report();
}

module.exports = { test: test, assert: assert, throws: throws, close: close, done: done, state: state };
