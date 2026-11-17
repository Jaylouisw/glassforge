# Changelog

All notable changes to Glassforge. The format follows [Keep a Changelog](https://keepachangelog.com/),
and the project uses [Semantic Versioning](https://semver.org/).

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
