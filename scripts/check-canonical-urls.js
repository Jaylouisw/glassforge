#!/usr/bin/env node
/**
 * Every URL in the repo has to point at the place the project actually lives.
 *
 * The links have now survived two moves - onto a self-hosted Forgejo and back to GitHub - and each
 * time some of them did not follow. When the project was on Forgejo the README still told people to
 * clone from GitHub, the hardware-request button opened a GitHub issue form, SECURITY.md sent
 * vulnerability reports to a GitHub advisory form, and package.json advertised a GitHub repository;
 * on the way back the same file set pointed at the forge instead. None of those
 * is where work happens, so the first instruction a contributor followed took them somewhere else -
 * and nothing failed when it happened, because a stale URL is invisible to every other test.
 *
 * This makes it a build failure. The canonical base lives in `scripts/canonical.js`; change it there
 * and this reports every place that needs to follow.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const canonical = require('./canonical');

const ROOT = path.join(__dirname, '..');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.github-cache']);
const CHECK_EXT = new Set(['.md', '.js', '.json', '.yml', '.yaml', '.html', '.txt']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.forgejo') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (CHECK_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

// `root` exists so the guard's own test can plant drift in a throwaway directory. It used to plant
// it in README.md and restore it in a `finally` - correct while the test is the only writer, but a
// `git add -A` taken while the suite was running captured the mutated README into a commit (a clone
// URL of `https://example.invalid/repo`), which is a worse defect than the one the guard protects.
// A test that cannot touch a tracked file cannot be captured mid-flight.
function check(root) {
  const base = root || ROOT;
  const files = walk(base, []).sort();
  const problems = [];

  for (const file of files) {
    const rel = path.relative(base, file).split(path.sep).join('/');
    if (canonical.EXEMPT_FILES.has(rel)) continue;
    // Reasoned exceptions: each entry in canonical.ALLOW says why that file must name the old
    // location. A file cannot be quietly added here without a reason a reader can judge.
    const allowed = Object.prototype.hasOwnProperty.call(canonical.ALLOW, rel);

    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    // A cheap pre-filter. It has to cover every rule below, or the file is skipped before the
    // rule sees it - which is exactly how the GitHub-CLI rule passed silently at first.
    if (!/git\.jayw\.uk|odin:3000|FORGEJO_TOKEN|forgejo-api/i.test(text)) continue;

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 1. The old repository URL, in any of its forms.
      for (const pattern of allowed ? [] : canonical.FORBIDDEN) {
        if (pattern.test(line)) {
          problems.push({
            file: rel, line: i + 1, code: 'E_STALE_REPO_URL',
            detail: 'points at the retired Forgejo instance; the canonical home is ' + canonical.BASE,
            text: line.trim()
          });
          break;
        }
      }

      // 2. Instructions that only worked on the old forge: its token file and its API wrapper.
      //    `gh` is now the supported CLI, so the rule points the other way round.
      if (!allowed && /FORGEJO_TOKEN|forgejo-api/.test(line)) {
        problems.push({
          file: rel, line: i + 1, code: 'E_FORGEJO_ONLY_TOOLING',
          detail: 'the Forgejo token file and API wrapper are gone; use the `gh` CLI',
          text: line.trim()
        });
      }
    }
  }

  // 3. The clone instructions and badges, which are the two most-followed URLs in the project,
  //    must match the canonical base exactly rather than merely not being the old forge.
  const readme = path.join(base, 'README.md');
  if (fs.existsSync(readme)) {
    const text = fs.readFileSync(readme, 'utf8');
    if (text.indexOf(canonical.clone()) === -1) {
      problems.push({
        file: 'README.md', line: 0, code: 'E_NO_CANONICAL_CLONE',
        detail: 'README does not contain the canonical clone URL ' + canonical.clone(),
        text: ''
      });
    }
    if (text.indexOf(canonical.badge('ci.yml')) === -1) {
      problems.push({
        file: 'README.md', line: 0, code: 'E_NO_CANONICAL_BADGE',
        detail: 'README does not carry a CI badge from ' + canonical.BASE,
        text: ''
      });
    }
  }

  return { ok: problems.length === 0, problems: problems, scanned: files.length };
}

if (require.main === module) {
  const res = check();
  if (res.ok) {
    console.log('OK — ' + res.scanned + ' files, every project URL points at ' + canonical.BASE);
    process.exit(0);
  }
  console.error('Canonical URL drift (' + res.problems.length + '):');
  for (const p of res.problems) {
    console.error('  ' + p.file + (p.line ? ':' + p.line : '') + '  ' + p.code);
    console.error('    ' + p.detail);
    if (p.text) console.error('    > ' + p.text);
  }
  process.exit(1);
}

module.exports = { check: check };
