'use strict';
// The worked examples in docs/PARTS.md are parts, not illustrations: each one names a real model, so a
// figure corrected in a part file has to be corrected in the example too - and nothing was checking it.
// gpon-c-plus-8's receiver pair was corrected to -32/-12 dBm on 2026-11-24 (it had carried class B+'s
// -30/-8, which left 30.5 dB of upstream reach against a 32 dB class), while the olt example in the doc
// kept the old pair. The engine never reads the doc, so the only witness was a reader comparing two
// pages by eye. This suite is that reader.
const fs = require('fs');
const path = require('path');
const { test, assert, done } = require('./harness');
const parts = require('../engine/parts');

const registry = parts.createRegistry();
const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PARTS.md'), 'utf8');

// Prose fields: an example may legitimately shorten a label or drop the notes, and neither is a figure.
const PROSE = ['label', 'notes', 'sourceUrl', 'vendor', 'tags'];

/** Every top-level {...} object in `text`, so a block holding two examples yields two objects. */
const BACKSLASH = String.fromCharCode(92);

function objectsIn(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === BACKSLASH) escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  assert.strictEqual(depth, 0, 'docs/PARTS.md has an unbalanced brace inside a ```json block');
  return out;
}

function examples() {
  const found = [];
  const re = /```json\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(doc)) !== null) {
    for (const chunk of objectsIn(m[1])) {
      let parsed = null;
      try {
        parsed = JSON.parse(chunk);
      } catch (err) {
        assert.fail('a ```json block in docs/PARTS.md is not JSON: ' + err.message + '\n' + chunk);
      }
      if (parsed && parsed.kind && parsed.model) found.push(parsed);
    }
  }
  return found;
}

const EXAMPLES = examples();

test('a doc example parser that finds nothing would pass silently, so it must find them all', function () {
  // Eight kind sections, eight examples: cable, splitter, olt, ont, transceiver, closure, connector, splice.
  assert.strictEqual(EXAMPLES.length, 8, 'expected the eight kind examples, parsed ' + EXAMPLES.length);
});

test('every worked example names a part the catalogue actually has', function () {
  for (const ex of EXAMPLES) {
    assert.ok(registry.has(ex.kind, ex.model),
      'docs/PARTS.md shows ' + ex.kind + '/' + ex.model + ', which is not in parts/');
  }
});

test("every figure a doc example prints is that part's figure", function () {
  for (const ex of EXAMPLES) {
    const part = registry.get(ex.kind, ex.model);
    for (const key of Object.keys(ex)) {
      if (PROSE.indexOf(key) !== -1) continue;
      assert.deepStrictEqual(ex[key], part[key],
        'docs/PARTS.md ' + ex.kind + '/' + ex.model + ' prints ' + key + ': ' + JSON.stringify(ex[key]) +
        ', the part says ' + JSON.stringify(part[key]) +
        ' - correct whichever is wrong, and both live in the same commit');
    }
  }
});

done();
