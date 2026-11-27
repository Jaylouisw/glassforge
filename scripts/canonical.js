'use strict';
/**
 * Where this project actually lives.
 *
 * Development is on GitHub. Every URL a reader might follow - clone instructions, issue links,
 * badges, package metadata - has to agree with this file, because a stale one sends a contributor
 * somewhere the work is not happening.
 *
 * This project spent a few weeks on a self-hosted Forgejo instance and came back. The move is the
 * reason the guard exists in the direction it does: on the way out it forbade GitHub URLs, and on
 * the way back it forbids the Forgejo ones. Same rule, opposite home.
 *
 * `scripts/check-canonical-urls.js` enforces it and `test/canonical-urls.test.js` proves the
 * checker can fail. Change the base here and run that test to find every place that must follow.
 */

const OWNER = 'jaylouisw';
const NAME = 'glassforge';

// The public, canonical home.
const WEB = 'https://github.com';

const BASE = WEB + '/' + OWNER + '/' + NAME;

// URL forms that must never appear in a tracked file. CHANGELOG.md is exempt: it records what
// happened, and editing history to pretend a move never occurred is a worse lie than a stale link.
const FORBIDDEN = [
  /git\.jayw\.uk/i,
  /odin:3000/i
];

const EXEMPT_FILES = new Set(['CHANGELOG.md']);

/**
 * Files that may name the old location on purpose, each with the reason it must. The rule is not
 * "the old forge may never appear" - the rule is "nothing may present it as the place to clone
 * from or contribute to".
 */
const ALLOW = {
  'test/canonical-urls.test.js': 'plants a stale URL deliberately to prove the guard can fail',
  'scripts/canonical.js': 'defines the forbidden patterns, so it has to contain them',
  'scripts/check-canonical-urls.js': 'names the forbidden patterns in order to report them'
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
    return BASE + '/blob/' + (branch || 'main') + '/' + path;
  },
  // GitHub's own badge endpoint. Forgejo's was /badges/workflows/<file>/badge.svg and it answered a
  // missing workflow with a red badge, which is one of the reasons the links were guarded at all.
  badge: function (workflow, label) {
    return BASE + '/actions/workflows/' + workflow + '/badge.svg' +
      (label ? '?label=' + encodeURIComponent(label) : '');
  }
};
