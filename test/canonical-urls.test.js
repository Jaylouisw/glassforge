'use strict';
// A guard nobody has seen fail is a guard nobody knows works.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, done } = require('./harness');
const canonical = require('../scripts/canonical');
const { check } = require('../scripts/check-canonical-urls');

const ROOT = path.join(__dirname, '..');

test('the canonical base is the GitHub repository', function () {
  assert.strictEqual(canonical.BASE, 'https://github.com/jaylouisw/glassforge');
  assert.strictEqual(canonical.clone(), canonical.BASE + '.git');
  assert.strictEqual(canonical.issue('bug_report.yml'), canonical.BASE + '/issues/new?template=bug_report.yml');
  assert.strictEqual(canonical.badge('ci.yml'), canonical.BASE + '/actions/workflows/ci.yml/badge.svg');
  assert.strictEqual(canonical.source('engine/geo.ts'), canonical.BASE + '/blob/main/engine/geo.ts');
});

test('no tracked file presents the retired forge as the place to clone or contribute', function () {
  const result = check();
  assert.deepStrictEqual(result.problems, [], JSON.stringify(result.problems, null, 2));
  assert.ok(result.scanned > 5, 'only ' + result.scanned + ' files scanned - the walker is broken');
});

test('the checker fails on a planted stale URL', function () {
  // A throwaway root, never a tracked file: a guard test that mutates README.md and restores it in a
  // `finally` can be caught mid-flight by a `git add -A`, and then the fixture ships.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-urls-'));
  try {
    fs.writeFileSync(path.join(dir, 'README.md'),
      '# probe\n\nClone from ' + canonical.clone() + '\n\n[![CI](' + canonical.badge('ci.yml') + ')]\n');
    fs.writeFileSync(path.join(dir, 'stale.md'), 'git clone https://github.com/Jaylouisw/glassforge.git\n');
    const result = check(dir);
    assert.strictEqual(result.ok, false, 'the planted URL was not caught');
    assert.ok(result.problems.some(function (p) { return p.file === 'stale.md' && p.code === 'E_STALE_REPO_URL'; }),
      JSON.stringify(result.problems, null, 2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the checker also catches a README without the canonical clone URL and badge', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-urls-'));
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# probe\n\nnothing to see\n');
    const result = check(dir);
    const codes = result.problems.map(function (p) { return p.code; });
    assert.ok(codes.indexOf('E_NO_CANONICAL_CLONE') !== -1, codes.join(','));
    assert.ok(codes.indexOf('E_NO_CANONICAL_BADGE') !== -1, codes.join(','));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
