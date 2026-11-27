# Contributing to Glassforge

Development happens on GitHub at
[jaylouisw/glassforge](https://github.com/jaylouisw/glassforge). Issues and pull requests there are
the only tracker: the project spent a few weeks on a self-hosted forge and came back, and that instance
is a read-only archive nothing is filed, reviewed or merged on. Push a branch with
`bash scripts/push-branch.sh <branch>` — it names the destination, refuses `main` and prints the
compare URL — or by hand with `git push -q origin HEAD:refs/heads/<branch>`.

```bash
git clone https://github.com/jaylouisw/glassforge.git
cd glassforge
npm install   # devDependencies only — the TypeScript compiler; nothing is installed at runtime
npm test
```

## The shape of a change

**One logical change per pull request.** One issue ↔ one PR. Docs, CI and code go in separate PRs even
when they belong to the same piece of work: a PR that fixes two things cannot be reverted, bisected or
reviewed cleanly.

**Never build a feature nobody asked for.** Open an issue, or comment on one, and wait for a decision.
A suggestion in conversation is not approval for a branch. An unrequested flag, abstraction or
dependency is work that has to be undone.

**Zero runtime dependencies.** No npm package on the server, no framework, build step or CDN in the
browser. A PR adding one is closed unless a maintainer asked for it in the issue first.

**Performance work is welcome without an approval round, with a number attached to both ends.**
"Faster" is unverifiable; `9.96 ms → 1.39 ms over 2,015 models` is a review.

## Tests come with the change

Every suite is a standalone Node script in `test/` that prints `<n> passed, <m> failed` and exits
non-zero on failure. `scripts/run-tests.js` discovers them by glob — a new suite is picked up with no
registration, which is the only way a suite cannot be silently left out of the run.

- **Test the refusal as well as the success.** A validator that accepts everything passes every test
  that only feeds it good input.
- **Derive the expected number in a comment.** The budget tests state the arithmetic
  (`3.0 km × 0.22 = 0.66 dB`) next to the assertion, so a change has to disagree with arithmetic
  rather than with an old run.
- **When an existing assertion fails because the behaviour it recorded was the bug, correct the
  assertion with a comment naming what it used to claim.** Never weaken the fix to keep it green.

## New modules are TypeScript

`engine/foo.ts` compiles in place to `engine/foo.js`, and the emitted `.js` is committed so a clone
still runs with no build. Run `npm run build` before pushing: CI fails when the committed `.js`
disagrees with its source, and `git status` on `*.js` after the build has to be empty. `any` is
refused (`node scripts/check-no-any.js`) — use `unknown` and narrow it, with `engine/geo.ts` as the
reference. A test stays `.js`, because `scripts/run-tests.js` only discovers `*.test.js`; a suite that
exists solely as `.ts` is silently skipped. The reasoning and the pitfalls are in
[docs/adr/0004-typescript-hybrid-and-no-any.md](docs/adr/0004-typescript-hybrid-and-no-any.md).

## Documentation is part of the change

- Counts come from the code: `node scripts/count-parts.js` renders the catalogue line in the README,
  and `--check` fails the build when it drifts.
- A claim about behaviour gets checked by driving the engine, not by reading it. If `docs/SPEC.md`
  says a design is refused, there is a test that refuses it.
- URLs point at the canonical repository. `node scripts/check-canonical-urls.js` enforces it.

## The CI matrix is the floor

`ci.yml` runs Node 18, 20 and 22, because the project's floor is 18 (`package.json` → `engines`) and a
developer on 24 can use an API that only exists on 24. `scripts/check-node-surface.js` catches that
without a second interpreter.

A pull request is not done until:

- `npm test` is green on all three, and
- `node scripts/smoke-http.js` passes, and
- the PR body says what changed and what it deliberately did not change.

Never merge red, and never silence a check.

## Adding a part to the catalogue

1. Drop `parts/<kind>/<model>.json` — the model slug must match the filename.
2. Fill in `sourceUrl`. For a cable, splitter, OLT, ONT or transceiver the validator refuses the spec
   without it — an optic's launch power and sensitivity are datasheet figures exactly as a cable's
   attenuation is.
3. `node scripts/audit-parts.js` to see what the validator thinks.
4. `node scripts/count-parts.js` to update the README counts.
5. One PR per vendor or per part family, with the datasheet figures quoted in `notes`.

## Reporting a bug

Open an issue with: what you did, what you expected, what happened, and the project JSON if it is not
sensitive (paste the design, not a screenshot of it). A design that produces a wrong verdict is the
most valuable bug report this project can receive — include the OLT, ONT, spans, splitter models and
the verdict you expected.
