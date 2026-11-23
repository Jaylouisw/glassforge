'use strict';
/**
 * Refuse the `any` type in TypeScript sources.
 *
 * Jay's rule is that `any` is never used: it switches off the checking that is the entire reason for
 * writing TypeScript. `unknown` plus a narrowing guard is the replacement, and a library's own
 * declaration files are the only place an `any` is allowed to exist (skipLibCheck handles those).
 *
 * This is a deterministic check rather than a sentence in a style guide, because a style guide relies
 * on someone reading the diff carefully at 3am.
 *
 *   node scripts/check-no-any.js
 *   node scripts/check-no-any.js --list     # print every scanned file
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXTS = new Set(['.ts', '.mts', '.cts']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'data']);

// Patterns are applied after comments are stripped, so `// never use any` does not trip the check.
const BANNED = [
  { name: 'type annotation', re: /:\s*any\b/g },
  { name: 'assertion', re: /\bas\s+any\b/g },
  { name: 'generic argument', re: /<\s*any\s*(?:,|>)/g },
  { name: 'array of any', re: /\bany\s*\[\]/g },
  { name: 'Array<any>', re: /\bArray\s*<\s*any\s*>/g },
  { name: 'Record with any', re: /\bRecord\s*<[^>]*\bany\b[^>]*>/g }
];

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

/** Remove comments but keep line numbering stable, so a finding points at the real line. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (line, prefix) => prefix + ' '.repeat(Math.max(0, line.length - prefix.length)));
}

function check(file) {
  const source = fs.readFileSync(file, 'utf8');
  const stripped = stripComments(source);
  const lines = stripped.split('\n');
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    for (const rule of BANNED) {
      rule.re.lastIndex = 0;
      if (rule.re.test(lines[i])) {
        findings.push({
          line: i + 1,
          rule: rule.name,
          text: source.split('\n')[i].trim()
        });
      }
    }
  }
  return findings;
}

function main(argv) {
  const list = argv.indexOf('--list') !== -1;
  const files = walk(ROOT, []).sort();
  const results = files.map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), findings: check(f) }));
  const bad = results.filter((r) => r.findings.length);

  if (list) for (const r of results) console.log('  ' + r.file);

  if (!bad.length) {
    console.log('No `any` in ' + files.length + ' TypeScript file(s).');
    return 0;
  }
  for (const r of bad) {
    for (const f of r.findings) {
      console.log(r.file + ':' + f.line + '  ' + f.rule + '  ' + JSON.stringify(f.text));
    }
  }
  console.log('\n' + bad.length + ' file(s) use `any`. Use `unknown` and narrow it, or name the real type.');
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main: main };
