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

/**
 * Provenance rules the validator cannot state, because they are about prose rather than numbers.
 *
 * ADR-0003 asks every part for a `sourceUrl` that resolves to the document the figure came from, and
 * `notes` that say what kind of figure each one is and that it must be replaced with the part actually
 * purchased. Neither is checkable by a type, and both failed silently once already: nine of thirty-seven
 * notes carried the caveat, three connectors cited an IEC colour-management standard, five closures
 * cited a cable recommendation, and every row printed a tick.
 */
const REPLACEMENT_RE = /replace[\s\S]{0,160}?\b(buy|buys|bought|purchase[sd]?|procure[sd]?|install(?:s|ed)?)\b/i;

function provenanceProblems(spec) {
  const problems = [];
  if (typeof spec.sourceUrl !== 'string' || !/^https:\/\/\S+$/.test(spec.sourceUrl)) {
    problems.push('sourceUrl is missing or not an https URL - the figure came from somewhere');
  }
  if (typeof spec.notes !== 'string' || !spec.notes.trim()) {
    problems.push('notes is missing: say what kind of figure each one is');
  } else if (!REPLACEMENT_RE.test(spec.notes)) {
    problems.push('notes does not say the figures must be replaced with the part actually purchased');
  }
  return problems;
}

const registry = engine.createRegistry();
const counts = registry.counts();
const provenance = [];
for (const kind of engine.parts.KINDS) {
  for (const spec of registry.all(kind)) {
    const problems = provenanceProblems(spec);
    if (problems.length) provenance.push({ kind: kind, model: spec.model, problems: problems });
  }
}

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
    const prov = provenance.find(function (p) { return p.kind === kind && p.model === spec.model; });
    if (prov) for (const problem of prov.problems) console.log('      prov:  ' + problem);
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

if (provenance.length) {
  console.error('\n' + provenance.length + ' part(s) with incomplete provenance:');
  for (const entry of provenance) {
    console.error('  parts/' + entry.kind + '/' + entry.model);
    for (const problem of entry.problems) console.error('    ' + problem);
  }
  process.exit(1);
}

console.log('\nAll parts validate, and every part names its source and carries the replacement caveat.');
