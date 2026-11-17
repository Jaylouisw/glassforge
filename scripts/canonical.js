'use strict';
/**
 * Where this project actually lives.
 *
 * Development is on Forgejo, not GitHub. Every URL a reader might follow - clone
 * instructions, issue links, badges, package metadata - has to agree with this file, because a
 * stale one sends a contributor somewhere the work is not happening.
 *
 * `scripts/check-canonical-urls.js` enforces it and `test/canonical-urls.test.js` proves the
 * checker can fail. Change the base here and run that test to find every place that must follow.
 */

const OWNER = 'jaylouisw';
const NAME = 'glassforge';

// The public, canonical home.
const WEB = 'https://git.jayw.uk';

const BASE = WEB + '/' + OWNER + '/' + NAME;

// URL forms that must never appear in a tracked file. CHANGELOG.md is exempt: it records what
// happened, and editing history to pretend a move never occurred is a worse lie than a stale link.
const FORBIDDEN = [
  /github\.com\/Jaylouisw\/glassforge/i,
  /github\.com\/jaylouisw\/glassforge/i
];

const EXEMPT_FILES = new Set(['CHANGELOG.md']);

/**
 * Files that may name the old location on purpose, each with the reason it must. The rule is not
 * "github.com may never appear" - the rule is "nothing may present GitHub as the place to clone
 * from or contribute to".
 */
const ALLOW = {
  'test/canonical-urls.test.js': 'plants a stale URL deliberately to prove the guard can fail'
};

module.exports = {
  OWNER: OWNER,
  NAME: NAME,
  WEB: WEB,
  BASE: BASE,
  FORBIDDEN: FORBIDDEN,
  EXEMPT_FILES: EXEMPT_FILES,
  ALLOW: ALLOW,

  repo: function (path) { return BASE + (path || ''); },
  clone: function () { return BASE + '.git'; },
  issue: function (template) {
    return BASE + '/issues/new' + (template ? '?template=' + template : '');
  },
  source: function (path, branch) {
    return BASE + '/src/branch/' + (branch || 'main') + '/' + path;
  },
  badge: function (workflow, label) {
    return BASE + '/badges/workflows/' + workflow + '/badge.svg' +
      (label ? '?label=' + encodeURIComponent(label) : '');
  }
};
