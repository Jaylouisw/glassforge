# Changelog

All notable changes to Glassforge. The format follows [Keep a Changelog](https://keepachangelog.com/),
and the project uses [Semantic Versioning](https://semver.org/).

Each suite count below is what `node scripts/run-tests.js` printed at that release's commit — the
chain is 13 / 107 (0.1.0) → 16 / 141 (0.2.0) → 17 / 156 (0.3.0) → 18 / 174 (0.4.0). `main` printed
**37 suites / 395 assertions** on 2026-11-24 at `6f46a81`; `node scripts/run-tests.js` prints the figure
for today. A count in a section is a snapshot, never a promise.

## [Unreleased]

The plan leaves the browser: a printable page with the drawing, the cable to buy, the splice schedule
and the checks, and a PNG of the drawing at a stated scale.

### Added

- **`GET /print/project/:id`** — server-rendered HTML built from the engine's own numbers: the plan
  SVG (same projection as the canvas) with a 1-2-5 scale bar and its `1 px = … m` figure, the
  validation errors and warnings, the cable-to-buy table per model and per span, and a splice schedule
  for every closure and splitter. No `<script>`, no remote asset; an unknown id is a 404 HTML page and
  an unpriceable cable model names the error in the cable section instead of a 500.
- **`engine.network.spliceTable`** — per splice point, each strand on each touching cable with its
  TIA-598 address and colour and the strand it is spliced to (`parked` when it is on one cable only).
  Non-positive or non-integer strand indices are skipped rather than throwing.
- **`scene.scaleBar` / `scene.exportPlan`** — the scale-bar metres for a given metres-per-pixel, and
  the size and metres-per-pixel of a 2× PNG export; both refuse a missing projection instead of
  drawing or printing zero.
- **Print / PDF and PNG controls** in the toolbar; the PNG is rasterised from the canvas SVG and
  carries the `exportPlan` label on the drawing.
- Tests: `print-export` adds 9 assertions (scale bar, export arithmetic, splice schedule), `api-http`
  adds 5 (the page, its escaping, an empty plant, a missing id, an unpriceable cable) and
  `ui-dom-contract` adds 1 (the two toolbar controls are wired). The repository total is the runner's.

### Fixed

- **A design field the budget does not read is refused, not skipped.** `opticalBudget` and
  `pointToPoint` read a fixed list of fields, so a key that is a near miss of one of them — a singular
  `splitter` for `splitters`, `margin` for `marginDb`, `headend` for `headEnd`, one letter out — was
  ignored while the plan lost the loss it named. A 1:8 splitter sent as `splitter` budgeted a 15 km
  GPON B+ ODN at **4.3 dB instead of 14.8 dB**, a received power 10.5 dB optimistic, and a verdict
  computed on fibre that will not light, answered `200`. `engine/design-fields.ts` now refuses the
  near miss before any loss is computed, naming the field that was meant and listing the ones the
  budget reads; `/api/design/budget` turns that into a `400`. Unrelated keys (`name`, `notes`, a
  caller's own bookkeeping) are still ignored, because a guard that refused every unknown key would
  refuse a caller who is not wrong.
  Tests: `budget-design-fields` adds 7 (the plural budgets the splitter, the singular refused by name,
  the reason in the sentence, a case slip on the active budget, a prefix, an unrelated key unchanged),
  and `api-http` asserts the same refusal as a `400` naming the field.
- **A blank KML coordinate cell is not the zero meridian.** `kml.parseCoordinates` converted each
  `lon,lat[,alt]` field with `Number()` before testing it, and `Number('')` is 0 - a legal longitude -
  so a tuple with an empty cell imported as a point on the Greenwich meridian. One blank cell in a
  route that is 111.2 m measured 7 102.5 m of cable. A tuple that cannot be read is now dropped, counted
  (`routes[].dropped`, `droppedCoordinates` in the import response) and named in the UI's import
  banner, instead of silently moving the route.
- **A splitter's ports are counted in fibres, not cables.** `network.capacity` counted one port per
  cabled output leaving a splitter site, so a site whose customers share one distribution cable — the
  shape `emitTerminalTree` emits, one strand per ONT — reported `portsUsed: 1` on a 1:8 that was full.
  `capacity()` on an auto-designed eight-house 1:8 read "1 of 8"; a ninth customer added to the same
  cable then passed `validate`, budgeted `ok` and went into the bill of materials as a fibre nobody
  could light, because the OLT-level checks (cascade 8, 9 ONTs inside 8 × 64) cannot see it. The
  splice schedule had always numbered those ports per strand, so the two views disagreed. The count is
  now a walk from the splitter: one port per ONT below it, one per downstream splitter (where it
  stops — the cascade rule one level down), and a listed strand with no ONT behind it spends nothing.
  The refusal now reads `has 9 fibres leaving it on 8 output ports … 1 fibre has no port`.
  Tests: `splitter-ports` adds 4 (shared cable full at eight, a ninth refused by name, spare strands
  cost nothing, two downstream splitters cost two).
- **A demand row with an empty coordinate is rejected, not placed at 0,0.** `engine.demand.prepare`
  takes a CSV or an array of rows, and only the CSV path tested the raw cell before `Number()`.
  `Number('')` is 0 — and so are `Number(null)` and `Number(' ')` — and 0,0 passes the range check, so
  an array row with a blank latitude or longitude became a house in the Gulf of Guinea. Blank rows all
  landed on that same phantom point, so `dedupe` collapsed them into one and three broken rows left no
  rejection record at all. Arrays are what `POST /api/import/demand` and `POST /api/design/synthesise`
  receive, and a CSV converted to JSON is exactly where empty cells survive as `""`. `parseArray` now
  rejects an empty coordinate with `latitude or longitude is empty` and a non-numeric one with
  `latitude/longitude are not numbers`, while a numeric `0` remains a legitimate coordinate. Tests:
  `demand-input` adds 3.
- **A money objective prices the drums you buy, not the metres you hang.** `design.synthesise` charged
  cable as `cablePerM × designM`, so the cost it ranked by disagreed with the BOM it had just built:
  a 30-house PON buying 8 km on five drums (5.9 km of design length: three 2 km 12-fibre and two 1 km
  drops) was quoted 9957.35 instead of 12144, because the 2.1 km of drum you pay for and never hang
  was absent from the ranking. Drums are bought whole and rounded once per model (SPEC §5), so a spare drum is money; cost
  now sums `cablePerM × purchaseM` per model plus the priced splices, closures and splitters.
  `metrics.costBreakdown: { cable, splices, closures, splitters, total }` reports the terms (both it
  and `cost` are `null` without a cost model), so a ranked-by-money verdict is reviewable the way a
  budget is. Tests: new suite `cost-model`, 4 assertions (the priced purchase, the terms summing to
  the total, `null` without a model, and a single-drum design pricing one drum).
- **A span that needs two cables buys two cables.** Auto-design writes `spans[].bundles` when the
  fibres a span carries do not fit the largest cable in the ladder — 160 customer fibres is two
  144-fibre cables over one measured route — and its own BOM counts them (fibre-metres, `cableM`,
  the per-model purchase). `GET /api/projects/:id/bom` read the route length once, so the cable page
  for that plant quoted **half the cable** the design had just ranked and bought one drum where two
  were needed: a 1.2 km trunk with `bundles: 2` priced 1236 m instead of 2472 m. `billOfMaterials` now
  multiplies the measured route by the bundle count and reports it, keeping `routeM` as the map length
  and `designM` as what is bought; `strandLedger` counts every cable's capacity, so 18 strands on a
  2 × 12 span is 75% rather than overbooked, and an overbooked bundle names its capacity as
  `2 x 12-fibre`. `network.validate` refuses a `bundles` that is not a positive whole number (a
  hand-edited `0` would buy no cable for a span drawn on the map) and `/bom` names that span instead of
  answering 500. Tests: `length-and-bom` adds 4, including one that prices the same auto-designed plant
  through both BOMs and requires them to agree; `strand-ledger` adds 2, `plant-validation` 1 and
  `api-ops-validation` 2.
- **A strand is addressed in its own cable's tube size, not always twelve.** Every cable part publishes
  `fibersPerTube` and `parts.validate` holds it to 1..24, but nothing read it: `network.spliceTable`
  called `fiber.addressFor(index)` with no options, so a 24-per-tube ribbon's strand 25 was printed
  `T03-F01` when the tray says `T02-F01` — a wrong tube on the one sheet a crew splices from. Each row's
  address now comes from the span's own cable, so two cables of different tube sizes spliced at one
  closure get one address each (the pairing the crew reads off the two trays), a splitter's input and
  port rows follow their own cables, and a span naming a cable the catalogue does not hold still renders
  the standard default instead of dropping the strand. The UI's thread diagram reads the same
  `fibersPerTube` from the catalogue it already loads. New suite `strand-address` adds 6 assertions (the
  geometry itself, a closure on a ribbon, two tube sizes at one closure, a splitter tail, a 1-fibre drop,
  an unknown model).
- **A splitter has its own port count, and the plant check now reads it.** `engine.network.capacity`
  measured the plant only against the OLT's limits (deepest cascade, total ONTs against
  `maxSplitRatio`), so a 1:8 cassette with nine or twelve drops hanging off it validated clean: nine
  ONTs on one 1:8 site is a cascade of 8, well inside 128, and 9 is inside `ports x ratio`. Ports are
  now counted per site by the branches that leave it toward the customers — a downstream splitter
  costs its parent one port however many ONTs sit behind it — and an overbooked site is an error that
  names the node's label and id, the count, the part and the ratio. `capacity` also exposes
  `splitterPorts: [{ node, name, model, ratio, portsUsed, overbooked }]` (`[]` for an active plant or
  a plant whose root count cannot be resolved). New suite `test/splitter-ports` adds 8 assertions:
  exactly eight drops pass, nine are refused by name, a legal 1:8 → 1:8 cascade keeps sp1 at one port,
  the overbooked site is the one named, eight drops plus a child splitter is nine outputs, an
  unconnected splitter is a not-connected warning rather than a port error, an active plant reports
  no splitter ports, and two sites are counted one at a time.
- **A splitter is not a splice.** `engine.network.spliceTable` reported every strand at a splitter as
  joined to the chain on the other side, so a 1:8 site's sheet said the feeder fibre was spliced
  straight through to a customer's drop — the one mis-wiring the schedule exists to prevent. A
  splitter's rows now carry `via: 'splitter-input'` (the cable nearer the head end, by hop count from
  the root, with a splitter tail winning the tie) or `via: 'splitter-port'` with a 1-based `port`, and
  `splicedTo` is empty; the point carries the part's `ratio` and `termination`, and the printed page
  shows `splitter input (1 splice)` / `splitter port P1` instead of a span id. Closure rows keep their
  through-splice and gained the same `via` field (`splice` / `parked`).

- **A span's splice and closure counts are counts, at the edit and in the validator.** `splices` and
  `closures` on a span were copied out of the request as given, so text, a negative, a fraction or
  `null` could land in a saved plant: `cableToBuy` then threw its own sentence, which reached the
  caller as a 500 blaming the server for their field. Both entry points refuse it now. The edit answers
  `span.splices must be a non-negative whole number or a list of splices, got "three"`, the validator
  lists `span "s1" has an invalid splices count "1.5"` in `errors`, and `/bom` for a project file
  edited by hand is a 400 naming the span instead of a 500. An absent count still means none, and a
  splice *list* still prices by its length. Tests: `api-ops-validation` adds six (text, negative,
  fraction, a PUT body, a hand-edited file, its BOM), `plant-validation` three.
- **A wrong method is a 405 that names what the path answers.** `GET /api/design/synthesise` — a URL
  straight out of docs/API.md — answered `404 not found`, which says the endpoint does not exist and
  sends the reader to check their path instead of their method. The server now knows the method set of
  every route it serves: a known path with the wrong method answers `405` with an `Allow` header and
  `method GET is not allowed on /api/design/synthesise - it answers POST`, `404` is kept for a path
  that is no endpoint at all, and `HEAD` follows `GET` where there is one. Tests: `api-http` adds
  seven.

### Changed

- `docs/API.md` documents the print route and the PNG scale arithmetic; the README lists plan export
  and no longer says there is none.
- **Drums are rounded once per model at that cable's own drum length, everywhere the number is
  printed.** Two places disagreed with the rule: `length.billOfMaterials` gave each span line its own
  `drums`/`purchaseM`/`spareM` (two 500 m runs of one cable read as two 2000 m purchases while the
  model line said one drum, and the printable plan showed the same contradiction as a "Drums" column),
  and the auto-design BOM hardcoded a 2000 m drum, so 915 m of 1-fibre drop cable — sold on a 1 km
  drum — was bought as 2000 m. Span lines now carry metres only, `design.candidates[].bom.lines[]`
  carries `drumM`/`spareM`, and the print page's per-span table has no drum column. Tests:
  `length-and-bom` and `auto-design` add one each.

Merged after 0.4.0 while the version stays at 0.4.0:

- **A caller's bad input to the design calculators is a 400, not a 500** — `POST /api/design/budget`
  with no `design.olt.model`, and the other design endpoints, now answer `{"error":"…"}` with a 400
  naming the field (#17).
- **XGS-PON optics follow G.9807.1** launch and receive tables (#22).
- **An ops edit that leaves the plant invalid is refused** instead of being saved (#26).
- **A link that is too loud says which inline pad fixes it.** `budget.opticalBudget` and
  `budget.pointToPoint` now report `attenuator: { overDb, padDb, maxPadDb, fits }` (or `null` when the
  receiver is at or below its overload point) and the overload reason quotes the pad, because
  "2.05 dBm is above its overload point" named the fault but left the remedy — subtract, round up,
  buy — to the reader. `fits: false` says a design is both too loud and too tight, so no pad
  satisfies both. A pad is ODN loss, so `maxPadDb` is capped by the margin and the class budget.
  Tests: `budget-optics` adds two (the PON pad, and the contradictory design) and
  `parts-long-reach-optics` adds five assertions to the EX short-run case.
- **`scripts/push-branch.sh`** — the one push recipe that works on this forge, plus
  `scripts/repo-state.js` for a one-call view of the repo (#23).
- **Test gaps the mutation audit found are closed**: 20 suites / 197 assertions (was 18 / 174).

### Fixed

- **A joint costs the light one splice, not one per strand it terminates.** `engine/link.js` computed
  `splices = joints × splicesPerJoint` (default `fibres`) and handed that number to
  `budget.pointToPoint`, whose `splices` is a count of loss events: one 24-fibre leg through one joint
  was charged 24 × 0.10 dB = 2.40 dB against 0.20 dB for the same duct on 2 fibres, and the same route
  could pass on 2 fibres and fail on 24 with nothing changed in the glass or the optics. SPEC §3's
  model — a closure node is one splice as the thread passes — now holds in link mode too: the budget
  gets one splice event per joint (or the `splices` option) and the crew's count moved to `splices`
  (`spliceEvents × splicesPerJoint`, summed in `bom.splices`, unchanged for the default call). New
  field `legs[].spliceEvents`. Tests: `link-design` adds two.

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
- 18 test suites / 174 assertions (was 17 / 156): `link-design` adds 14, `street-routing` adds
  `diversePaths` (1), the API suite adds 2, `auto-design` adds 1.

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
- 17 test suites / 156 assertions (was 16 / 141).

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
- 16 test suites / 141 assertions (was 13 / 107).

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
