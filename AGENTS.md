# AGENTS.md

Glassforge is an open-source fibre network planner: draw or import a plant, get an optical budget, a
splice-ready cable schedule and a cable-to-buy. Zero runtime dependencies, CommonJS, Node 18 floor.
Read `docs/SPEC.md` for the model and `GLOSSARY.md` for the vocabulary before changing behaviour.

## Invariants

- **No runtime dependencies.** No npm package in `engine/` or `server/`; no framework, build step or CDN
  in `web/`. `scripts/check-node-surface.js` holds the Node 18 API surface.
- **Honest numbers.** A missing figure is an error, never a silent zero. A refusal names the address or
  row that caused it — it never falls back to a straight line without saying so.
- **Two technologies, one loss model.** The root node type picks the budget: `olt` → PON, `headend` →
  active point-to-point. The passive loss is shared code, so the two verdicts cannot drift.
- **`main` is PR-only.** Branch → pull request → green CI → squash merge. Nobody commits to `main`.
  Branch protection sets `enable_push: false` but **`enable_status_check: false`**: the checks are not a
  gate the server enforces, they are evidence a merger reads. The runner appends `(push)` or
  `(pull_request)` to every context name, so a fixed required-check string would freeze every pull
  request — that is why it is off. Read the run before merging; do not assume green is guaranteed.
- **TypeScript for new modules, and never `any`.** New code is written `.ts`; legacy `.js` migrates as it
  is touched (`allowJs` is off, so a `.ts` module reaches a `.js` one with `require()` plus a local
  interface). The emitted `.js` is committed — build before you push, or CI fails on
  `npm run build && git diff --exit-code`. `any` is refused by `scripts/check-no-any.js`; use `unknown`
  and narrow it. See `docs/adr/0004-typescript-hybrid-and-no-any.md`.

## Work

```bash
npm run verify                             # everything CI runs: guards, suites, no-any, build
npm test                                   # the no-install subset: counts, control bytes, node surface, suites
npm run build                              # tsc: engine/x.ts -> engine/x.js (commit the output)
node scripts/smoke-http.js                 # boots the server on a real socket
node scripts/audit-parts.js                # catalogue validation
node server/index.js                       # :8000, GF_DATA for the data root
```

## Agent skills

### Issue tracker

Issues and pull requests live on the Forgejo instance, not on GitHub. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, spelled as their own names. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.

### Working habits

This repo is developed pair-of-hands-at-a-time against the Matt Pocock development skills (installed in
the agent, deliberately not vendored here): grill a plan before building it, turn the conversation into a
spec and then into tracer-bullet tickets, build test-first, review the diff on two axes (standards and
spec) before opening the pull request, and write the PR body from the template rather than from memory.
