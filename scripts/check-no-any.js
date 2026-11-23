'use strict';
/**
 * Refuse the `any` type in TypeScript sources.
 *
 * Jay's rule is that `any` is never used: it switches off the checking that is the entire reason for
 * writing TypeScript. `unknown` plus a narrowing guard is the replacement.
 *
 * This started life as six regular expressions and had two measured false negatives — `satisfies any`
 * and `${value as any}` — because a type position cannot be found reliably by looking at punctuation.
 * In TypeScript the word `any` almost never appears as anything other than the type, so the check now
 * walks the file as a small state machine, ignores comments and string text, and reports the bare
 * identifier anywhere else. Template literals are the one subtlety: `${...}` inside them is code again,
 * which is exactly how `as any` escaped a line-based regex.
 *
 *   node scripts/check-no-any.js
 *   node scripts/check-no-any.js --list     # print every scanned file
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXTS = new Set(['.ts', '.mts', '.cts']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'data']);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const IDENT = /[A-Za-z0-9_$]/;

/**
 * Return `{ line, column, text }` for every occurrence of the identifier `any` that is not inside a
 * comment or a string.
 */
function findAny(source) {
  const hits = [];
  const lines = source.split('\n');
  const inTemplateExpr = [];
  let state = 'code';
  let line = 1;
  let column = 0;
  let ident = '';
  let identStart = null;
  let braceDepth = 0;

  function record() {
    if (ident === 'any' && identStart !== null) {
      hits.push({ line: line, column: identStart + 1, text: (lines[line - 1] || '').trim() });
    }
    ident = '';
    identStart = null;
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '\n') {
      record();
      line++;
      column = 0;
      if (state === 'line-comment') state = 'code';
      continue;
    }
    column++;

    if (state === 'line-comment') continue;

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { state = 'code'; i++; column++; }
      continue;
    }

    if (state === 'single' || state === 'double') {
      if (ch === '\\') { i++; column++; continue; }
      if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"')) state = 'code';
      continue;
    }

    if (state === 'template') {
      if (ch === '\\') { i++; column++; continue; }
      if (ch === '`') { state = 'code'; continue; }
      if (ch === '$' && next === '{') { inTemplateExpr.push(braceDepth); braceDepth = 0; state = 'code'; i++; column++; }
      continue;
    }

    // state === 'code'
    if (ch === '/' && next === '/') { record(); state = 'line-comment'; i++; column++; continue; }
    if (ch === '/' && next === '*') { record(); state = 'block-comment'; i++; column++; continue; }
    if (ch === "'") { record(); state = 'single'; continue; }
    if (ch === '"') { record(); state = 'double'; continue; }
    if (ch === '`') { record(); state = 'template'; continue; }
    if (ch === '{') { record(); braceDepth++; continue; }
    if (ch === '}') {
      record();
      if (braceDepth === 0 && inTemplateExpr.length) {
        braceDepth = inTemplateExpr.pop();
        state = 'template';
      } else if (braceDepth > 0) {
        braceDepth--;
      }
      continue;
    }
    if (IDENT.test(ch)) {
      if (identStart === null) identStart = column - 1;
      ident += ch;
      continue;
    }
    record();
  }
  record();
  return hits;
}

function main(argv) {
  const list = argv.indexOf('--list') !== -1;
  const files = walk(ROOT, []).sort();
  if (list) for (const file of files) console.log('  ' + path.relative(ROOT, file).split(path.sep).join('/'));

  let bad = 0;
  let total = 0;
  for (const file of files) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const hits = findAny(fs.readFileSync(file, 'utf8'));
    if (!hits.length) continue;
    bad++;
    for (const hit of hits) {
      total++;
      console.log(relative + ':' + hit.line + ':' + hit.column + '  ' + JSON.stringify(hit.text));
    }
  }

  if (!bad) {
    console.log('No `any` in ' + files.length + ' TypeScript file(s).');
    return 0;
  }
  console.log('\n' + total + ' use(s) of `any` in ' + bad + ' file(s). Use `unknown` and narrow it, or name the real type.');
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main: main, findAny: findAny };
