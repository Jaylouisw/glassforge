# Changelog

All notable changes to Glassforge. The format follows [Keep a Changelog](https://keepachangelog.com/),
and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-11-17

Active optical networks, and auto-design from a list of addresses.

### Added

- **`transceiver` part kind** — an optic, with launch power, sensitivity, overload, wavelength and
  reach. Five parts: 1000BASE-LX, 1000BASE-ZX, 10GBASE-LR, 10GBASE-ER and 25GBASE-LR.
- **`budget.pointToPoint`** — an active link budgeted between two optics instead of against a PON
  class: same loss model, second verdict is `launch(min) − sensitivity`, plus a reach check. Both
  directions, overload detection, and a refusal when the ends disagree on rate or wavelength. The
  passive-loss calculation is now shared with the PON path (`computeOdn`), so the two cannot drift.
- **`headend` node type** — the root of an active plant. `network.trace`, `validate`, `capacity` and
  `designForOnt` all key off the root's technology, and a PON may no longer contain a transceiver at
  the customer end (or an active plant a splitter).
- **`engine/demand.js`** — parse a demand list from CSV (header aliases, `;`/tab, quoted fields) or
  JSON rows: rejects bad rows by number, drops and counts duplicates, refuses an empty list, and never
  turns an empty cell into latitude 0.
- **`engine/design.js`** — topology synthesis: PON at each splitter ratio (clustering with capacity
  and radius repair, feeder tree, tapered distribution tree), active Ethernet over a shared cable
  tree, and active home-run. Every candidate is validated, budgeted per ONT, costed in cable metres,
  fibre-metres and drum count, and ranked; infeasible candidates are reported with reasons rather than
  dropped. Deterministic: no `Math.random`, ordered tie-breaks.
- **API**: `POST /api/design/synthesise` (with optional `applyToProject`, which replaces the plant in
  one undoable step after validating it) and `POST /api/import/demand`.
- **UI**: an Auto-design panel — paste the list, give the head-end, compare every candidate in a table
  with its verdict and numbers, read the rationale, and apply the winner to the open project.
- **`docs/AUTO-DESIGN.md`** — the pipeline, the algorithms, the objective function, and what the
  synthesiser deliberately does not model.
- 16 test suites / 137 assertions (was 13 / 107).

### Fixed

- **A phantom splitter cascade.** `capacity()` multiplied the ratio of *every* splitter in the plant,
  so six 1:8 splitters at six different sites became "1:262144" and a perfectly good PON design was
  refused. It now walks the tree and takes the deepest single path.
- **Cable was not tapered.** `cableFor` returned the first cable in the (richest-first) ladder that
  fit, so every two-fibre branch was designed on 144-fibre cable — a BOM wrong by a factor of seventy.
  It now returns the smallest cable that carries the demand.
- **The feeder tree passed through splitter nodes.** A path to the third splitter site was charged
  three splitter losses. Every splitter site now has its own closure with the splitter on a 1 m tail.

### Changed

- `project.replacePlant` added: swapping a whole plant is one operation with one undo step.
- A project may hold either an `olt` or a `headend` root, not both.

## [0.1.0] — 2026-11-17

The first cut: a planner that can take a design from a route to a cable order.

### Added

- **Engine** (`engine/`), zero dependencies, CommonJS, Node 18 floor:
  - `fiber.js` — TIA-598 colours, tube/fibre addressing (`T03-F07`), parsing of what a technician
    types, plans for any fibre count.
  - `parts.js` — the registry: validation with reasons, per-kind rules, search keys cached on the spec.
  - `budget.js` — worst-case optical budget downstream (1490 nm) and upstream (1310 nm), receiver
    headroom and PON class budget as two independent verdicts, cascade limit, overload detection.
  - `length.js` — cable to buy: overlength, splice and closure reserves, whole drums; BOM aggregated
    per cable model and rounded once.
  - `network.js` — the plant as a tree: trace OLT → ONT, derive a budget from the path, strand
    ledger with overbooking detection, capacity against the OLT's own limits, structural validation.
  - `kml.js` — KML and KMZ import with no dependency (a zip reader on `zlib`), classification and
    duplicate reporting.
  - `project.js` — pure-data projects, 50 steps of undo, immutable edits.
  - `geo.js` — great-circle distance, Douglas-Peucker simplification, interpolation.
- **Parts catalogue** (`parts/`), 32 parts across 7 kinds: 8 cables, 6 splitters, 5 OLTs, 3 ONTs,
  5 closures, 3 connectors, 2 splices. Every loss figure carries its source and its caveat.
- **Server** (`server/`) — `http` + `fs`: static UI, parts catalogue with a body-derived ETag and
  gzip, projects, ops, undo, budgets, BOM, strand ledger, KML import. Projects stored as JSON under
  `GF_DATA`, written through a temp file and a rename.
- **UI** (`web/`) — canvas projection with aspect preserved, parts palette, place/connect tools,
  signal/cable/strands/splice/checks panels, KML import. No framework, no build step.
- **Tests** — 13 suites covering colours, registry rules, budget arithmetic in both directions, class
  budgets, BOM maths, plant tracing, strand accounting, validation, KML/KMZ, undo, canvas projection,
  the DOM namespace contract and the HTTP surface (107 assertions). Plus guards: control bytes, Node 18
  API surface, canonical URLs and README part counts.
- **CI** — Node 18/20/22 matrix, syntax check, smoke test over a real socket, Dockerfile checks.

### Known gaps

No basemap tiles, no accounts or multi-user editing, no OLT synchronisation, no PDF/PNG export, no
offline field mode. See the README for the honest list.
