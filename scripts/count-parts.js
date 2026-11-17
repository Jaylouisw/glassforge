#!/usr/bin/env node
/**
 * The catalogue counts in the README come from the catalogue.
 *
 * The README makes a claim a reader will act on ("32 parts"), and a hand-maintained number drifts the
 * first time somebody adds a splitter. This script renders the line from the registry and, with
 * `--check`, fails the build when the README disagrees - which is also what stops two branches from
 * both editing the number and conflicting.
 *
 * Usage:
 *   node scripts/count-parts.js            # rewrite the block in README.md
 *   node scripts/count-parts.js --check    # exit 1 if README.md is out of date
 */
'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('../engine');

const ROOT = path.join(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const START = '<!-- parts:start -->';
const END = '<!-- parts:end -->';

function label(kind, n) {
  const names = { cable: 'cables', splitter: 'splitters', olt: 'OLTs', ont: 'ONTs', closure: 'closures', connector: 'connectors', splice: 'splices' };
  return n + ' ' + (names[kind] || kind);
}

function render() {
  const counts = engine.createRegistry().counts();
  const kinds = engine.parts.KINDS.map(function (k) { return label(k, counts.byKind[k]); });
  return START + '\n**' + counts.total + ' parts across ' + engine.parts.KINDS.length + ' kinds** — ' +
    kinds.join(', ') + '.\n' + END;
}

function main() {
  const check = process.argv.includes('--check');
  if (!fs.existsSync(README)) {
    console.error('no README.md at ' + README);
    process.exit(1);
  }
  const text = fs.readFileSync(README, 'utf8');
  const block = render();
  const start = text.indexOf(START);
  const end = text.indexOf(END);

  if (start === -1 || end === -1) {
    console.error('README.md has no ' + START + ' … ' + END + ' block to keep the counts in');
    process.exit(1);
  }

  const current = text.slice(start, end + END.length);
  if (current === block) {
    console.log('OK — README part counts match the catalogue (' + block.split('\n')[1].replace(/\*\*/g, '') + ')');
    return;
  }

  if (check) {
    console.error('README part counts are out of date.\n  in README.md: ' + current.replace(/\n/g, ' ') +
      '\n  in the catalogue: ' + block.replace(/\n/g, ' ') + '\nRun: node scripts/count-parts.js');
    process.exit(1);
  }

  fs.writeFileSync(README, text.slice(0, start) + block + text.slice(end + END.length));
  console.log('README part counts updated.');
}

if (require.main === module) main();

module.exports = { render: render };
