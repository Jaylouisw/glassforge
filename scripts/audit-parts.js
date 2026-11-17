#!/usr/bin/env node
/**
 * Print the catalogue and every reason a part is not usable.
 *
 * `npm test` already refuses an invalid part, but the failure there is one line among a suite. This
 * is the command to run while adding one: it lists what loaded, from which file, and what the
 * validator thinks of each spec.
 *
 * Usage: node scripts/audit-parts.js [--kind=cable] [--verbose]
 */
'use strict';

const path = require('path');
const engine = require('../engine');

const argv = process.argv.slice(2);
const kindFilter = (argv.find(function (a) { return a.startsWith('--kind='); }) || '').split('=')[1] || null;
const verbose = argv.includes('--verbose');

const registry = engine.createRegistry();
const counts = registry.counts();

console.log('glassforge parts catalogue — ' + counts.total + ' parts');
for (const kind of engine.parts.KINDS) {
  if (kindFilter && kind !== kindFilter) continue;
  const specs = registry.all(kind);
  console.log('\n' + kind + ' (' + specs.length + ')');
  for (const spec of specs) {
    const check = engine.parts.validateSpec(spec);
    const flag = check.ok ? (check.warnings.length ? '!' : '✓') : '✗';
    console.log('  ' + flag + ' ' + spec.model.padEnd(26) + spec.label);
    if (verbose || !check.ok) {
      for (const error of check.errors) console.log('      error: ' + error);
    }
    for (const warning of check.warnings) console.log('      warn:  ' + warning);
  }
}

const validation = registry.validate();
if (!validation.ok) {
  console.error('\n' + validation.problems.length + ' catalogue problem(s):');
  for (const problem of validation.problems) {
    console.error('  parts/' + (problem.kind || '?') + '/' + (problem.model || '?'));
    for (const error of problem.errors || []) console.error('    ' + error);
  }
  process.exit(1);
}
console.log('\nAll parts validate.');
