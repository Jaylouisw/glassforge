# 0004 — TypeScript, hybrid, and never `any`

**Status:** accepted (2026-11-23)

## Context

Jay's standing rule is to prefer TypeScript over JavaScript and never to use the `any` type. The repo
was zero-dependency JavaScript on a Node 18 floor, with no build step, because `node server/index.js`
running straight from a clone is what makes the project easy to reason about and easy to page someone
into at 3am.

A full rewrite would have meant a build step before the server can start, a rewritten test runner, and
a rewrite of the guard scripts — all at once, in a repository several agents commit to in parallel.
Node 18 cannot run `.ts` at all, so *some* compilation is unavoidable if TypeScript is going to exist
here.

## Decision

**Hybrid.** New modules are written `.ts`; existing `.js` files are left alone and migrate when they are
touched for another reason.

- `tsconfig.json` compiles in place: `engine/foo.ts` → `engine/foo.js`. The emitted `.js` is **committed**,
  so a clone still runs with no install and no build.
- CI installs the compiler, builds, and fails when the committed output disagrees with its source
  (`npm run build && git diff --exit-code`). Generated code that is not reproducible is a lie about
  what was reviewed.
- A `.ts` module reaches a legacy `.js` module with `require()` plus a local interface. Mixing `allowJs`
  with an in-place `outDir` makes tsc try to overwrite its own inputs (TS5055), and the alternative —
  a `src/`→`dist/` split — would break every existing `require('./engine/...')` path for no gain.
- `any` is banned by `scripts/check-no-any.js`, wired into `npm run verify` and CI. `unknown` plus a
  type guard is the replacement; `engine/geo.ts` shows the shape (`isCoordinate(p: unknown): p is Coordinate`).
- The Node 18 surface guard and the control-byte guard now scan `.ts` as well as `.js`. Before this ADR
  they walked straight past a TypeScript file.

`engine/geo.ts` is the first migration: it is small, pure, used by nearly every module, and it needed
real types at its boundary anyway (`distanceM(a: unknown, b: unknown)` validates, then narrows).

## Consequences

- The compiler is the project's only dependency, and it is a devDependency: runtime stays zero-dependency.
- Two languages coexist, so `npm test` (no install) stays the fast local gate and `npm run verify`
  (install + build + every guard) is what CI runs. A lane without `node_modules` can still run the
  suites; it just cannot typecheck.
- Migrating a module means deleting its `.js` in the same commit as adding the `.ts`, or the compile
  refuses to overwrite its own input.
- Tests stay `.js` for now: `scripts/run-tests.js` discovers `*.test.js`, and a test that exists only as
  `.ts` would be silently skipped, which is the worst possible outcome for a test.
