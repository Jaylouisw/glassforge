# Changelog

All notable changes to Glassforge. The format follows [Keep a Changelog](https://keepachangelog.com/),
and the project uses [Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-11-23

Site-to-site links: a DC-to-DC circuit with both legs routed along the duct graph, diversity measured
rather than assumed, and leased segments that are budgeted but never bought as cable.

### Added

- **`engine/link.js`** — `link.design(...)`: two named sites, an optic at each end, no splitter and no
  ONT. Each leg is routed on the supplied graph and budgeted on its own with `budget.pointToPoint`, so
  reach, loss budget and overload are three verdicts per leg. Lengths are reported as `routedM` (the
  graph measurement), `ownM` (plus both site drops — the cable to buy) and `lengthM` (plus leased).
- **`street.diversePaths`** — minimum-cost edge-disjoint legs (Suurballe with Johnson potentials over
  the residual graph), falling back to the path that shares the fewest metres when the graph offers no
  second route. Every shared segment is returned with its metres and its geometry.
- **Leased (third-party) segments** — `{ provider, lengthM, lossDb, leg, cost }`: charged to the leg's
  budget and to the cost, excluded from the cable BOM. A segment without a stated loss is refused.
- **`budget.pointToPoint` third-party loss** — a leased span is a `third-party` line in the breakdown,
  counted in the ODN loss and in the path length used for the reach check; `fibreLengthM` stays the
  owned fibre, `leasedLengthM` and `pathLengthM` are reported beside it.
- **`POST /api/design/link`** — the circuit as JSON: `legs`, `paths`, `runs` (each with `method` and
  `route`), `diversity` (with a sentence), `thirdParty`, `bom` and a verdict.
- 18 test suites / 174 assertions (was 17 / 157): `link-design` adds 14, `street-routing` adds
  `diversePaths` (1), the API suite adds 2.

### Changed

- `docs/API.md`, `docs/AUTO-DESIGN.md` and `docs/SPEC.md` §9 describe the link contract; the README
  lists what a link does and does not model.

## [0.3.0] — 2026-11-17

Street routing: runs are measured, and drawn, along the streets instead of a detour factor.

### Added

- **`engine/street.js`** — a street/duct graph from KML, KMZ or JSON polylines: vertices merged within
  a tolerance, properties snapped onto the nearest edge (splitting it, and keeping the gap as the
  drop), Dijkstra, and the union of shortest paths from the root pruned to the edges that serve a
  terminal and contracted between the points a planner marks.
- **`design.synthesise` routing provider** — supplying `network` switches every candidate from
  straight-line × `routeFactor` to the graph. Spans carry their street geometry as `route`, runs
  report the method they were measured with, and the canvas draws routed spans as polylines.
- **`POST /api/import/network`** — build a graph from KML/KMZ/JSON and get its stats and edges back.
- **UI** — a street-network file input beside the auto-design controls, with the edge count and
  network length it loaded.
- **Refusals that name the address**: a property more than `maxSnapM` (default 250 m) from the network,
  or disconnected from the head-end, makes the candidate infeasible with the address ids listed.
- 18 test suites / 153 assertions (was 16 / 141).

### Changed

- The synthesiser is now a set of builders over a **routing provider** (straight-line or street), so
  both paths share the tree, the cable taper, the budget and the ranking.
- `runs[]` gained `method` and `route`; `routeMethod` reports the network it routed on.

### Fixed

- A cluster's medoid sits exactly on its splitter site, so its tree edge measured 0 m and the model
  refused the span. It is now the 1 m shortest real drop.

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
