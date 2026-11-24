# HTTP API

Everything the UI does goes through these endpoints, so anything the UI can do can be scripted.
All responses are JSON unless noted. Errors are `{ "error": "..." }` with `400` (bad input), `404`
(unknown thing) or `405` (wrong method); a `500` means the server broke, not that your design is wrong.

A `405` names the path and the methods it does answer, and carries them in `Allow` — `GET
/api/design/synthesise` is refused with `405 … it answers POST`, never `404`, because the endpoint
exists. `404` is for a path that is not an endpoint at all, and an action that is not one of a
project's (`/api/projects/:id/nope`) is one of those. `HEAD` follows `GET`; `OPTIONS` is not answered.

The server binds `127.0.0.1:8000` by default (`HOST`, `PORT`), and stores projects under `GF_DATA`
(default `data/`).

## Health

```
GET /api/health
→ { ok: true, name: "glassforge", version: "0.4.0",
    parts: { total: 55, byKind: { cable: 8, splitter: 8, olt: 9, ont: 5, transceiver: 13,
                                 closure: 6, connector: 4, splice: 2 } },
    projects: 0, uptimeS: 4 }
```

`version` is `package.json`'s. `parts.total` and `parts.byKind` are the catalogue on disk, so they
change whenever a part is added. The block above is a **snapshot, not a contract**: recorded on `main` on
2026-11-24, it is illustrative and will drift as the catalogue grows. The authorities are the endpoint
itself and `node scripts/count-parts.js`, whose `--check` mode keeps README's copy of that line honest —
re-record the block with the command below, never by editing the numbers by hand.

```
GF_DATA=/tmp/gf-port node server/index.js &
curl -s http://127.0.0.1:8000/api/health
```

## Parts

```
GET /api/parts                  → { counts, parts: { cable: [...], splitter: [...] } }
GET /api/parts?kind=splitter&q=1x8
GET /api/parts/:kind/:model     → one spec
```

`/api/parts` sends a **content-derived ETag** and honours `If-None-Match` (→ `304`) and
`Accept-Encoding: gzip`. The ETag is a hash of the body it just produced, so two consecutive identical
requests agree — an ETag that changes every request revalidates nothing. That is asserted in
`test/api-http.test.js`.

## Projects

```
GET    /api/projects               → { projects: [{ id, name, updatedAt, nodes, spans, onts }] }
POST   /api/projects { name, olt? }→ 201, the new project
GET    /api/projects/:id           → project + derived { summary, stats, errors, warnings }
PUT    /api/projects/:id { ... }   → validate and replace (refused with 400 + errors)
DELETE /api/projects/:id
POST   /api/projects/:id/ops       → apply one edit (below)
POST   /api/projects/:id/undo      → take back the last edit
```

Operations for `/ops`:

```json
{ "op": "add-node",    "node": { "type": "closure", "model": "nap-8", "lat": 51.5, "lon": -0.1 } }
{ "op": "add-span",    "span": { "from": "n1", "to": "n2", "cable": "g652d-loose-12", "lengthM": 240 } }
{ "op": "update-node", "id": "n2", "patch": { "name": "NAP 12" } }
{ "op": "move-node",   "id": "n2", "lat": 51.5001, "lon": -0.0999 }
{ "op": "remove-node", "id": "n2" }
{ "op": "remove-span", "id": "s1" }
{ "op": "rename",      "name": "Barrio Norte phase 2" }
```

A refused operation returns `400` with the reason and leaves the saved project untouched.

`summary.capacity` carries the OLT's limits (`ports`, `maxSplitRatio`, `splitterCascade`,
`theoreticalMaxOnts`) and, per splitter site, `splitterPorts: [{ node, name, model, ratio,
portsUsed, overbooked }]` — the ratio is the cassette's output count and `portsUsed` is the fibres
leaving that site: one per ONT below the splitter, one per downstream splitter (whose own ports are
counted at its own site). Counting cables instead of fibres read eight customers sharing one
distribution cable as one port used. An overbooked site also appears in `capacity.problems`, which is
what turns a `PUT` into a `400`.

## Auto-design

```
POST /api/design/synthesise
  { demand, headEnd: { lat, lon, name? }, technology?, routeFactor?, marginDb?,
    network?, maxSnapM?, joinToleranceM?,
    pon?: { ratios, olt, ont, maxDropM }, active?: { optics }, costs?, applyToProject? }
  → { ok, objective, routeMethod, technology, best, candidates, plant, runs, rationale, notes, applied? }

POST /api/import/network
  body: KML text, a KMZ buffer, or { edges: [{ coords }] }
  → { stats: { nodes, edges, lengthM, lengthKm }, edges: [{ id, lengthM, coords }] }

POST /api/import/demand
  { demand: "label,lat,lon\n..." }            (or an array of rows)
  → { points, rejected, duplicates, meta, bbox }
```

`demand` is CSV text or an array of `{ label?, address?, lat, lon }`. Rows without coordinates are
refused by row number — geocoding is off by default. `network` switches the router from the
straight-line factor to a street/duct graph; `/api/import/network` builds that graph and hands it back
so the caller can preview it (and send it as `network` unchanged). `applyToProject` replaces the project's plant in
one operation (one undo step) *after* validating it; without it, the design is returned and nothing is
written. Candidates that fail are returned with `feasible: false` and their reasons, never dropped.
With `costs`, `objective` is `cost` and every candidate's `metrics.cost` prices the drums the BOM buys
(`purchaseM`) plus the priced splices, closures and splitters, with the terms in
`metrics.costBreakdown: { cable, splices, closures, splitters, total }`; without `costs`, both are
`null`.
See [AUTO-DESIGN.md](AUTO-DESIGN.md).

## Site-to-site links

```
POST /api/design/link
  { sites: { a: { name?, lat, lon }, b: { name?, lat, lon } },
    optics: { a: transceiver model, b: transceiver model },
    network?: KML text | [polylines] | { edges: [{ coords }] },
    protection?: "diverse" (default) | "single",
    thirdParty?: [{ provider, lengthM, lossDb, leg?: "a"|"b"|"both", cost?, reference? }],
    fibres?, cable?, ladder?, connectors?, splices?, marginDb?, maxSnapM?, joinToleranceM? }
  → { ok, mode: "link", routeMethod, sites, legs, paths, runs, diversity, thirdParty, bom, verdict,
      reasons, warnings, notes }
```

Two named sites and an optic at each end, with **both legs routed along the supplied duct/street
graph** — there is no straight-line fallback while a graph is present. With `protection: "diverse"` the
legs are the minimum-cost edge-disjoint pair (Suurballe) where the graph allows one; where it does not,
the second leg is the path that shares the fewest metres and `diversity.shared` names every shared
segment with its metres (`diversity.sharedM` is `null` when there is only one leg: there is nothing to
compare). Each leg carries its own `budget` from `budget.pointToPoint`, so reach, loss
budget and overload are three verdicts per leg. `legs[].routedM` is the graph measurement,
`legs[].ownM` adds both site drops (the cable to buy) and `legs[].lengthM` adds leased segments.
`legs[].spliceEvents` is what the light crosses - one splice per joint on the leg, or the `splices`
option - and is what each leg's budget charges; `legs[].splices` is the crew's count, that number times
`splicesPerJoint` (default `fibres`), and `bom.splices` sums it. A 24-fibre leg through one joint is one
splice event and 24 splices to perform.
A leased segment that rides a leg this circuit built is charged to that leg's budget and to the cost,
and is never in `bom.cableM` (`bom.thirdParty.inCableBom === false`). A segment assigned to a leg that
was not built — `leg: "b"` under `protection: "single"`, on a circuit the graph only gave one route, or
on a request where routing failed — is still listed, with `attached: false`, and summed in
`unattachedM`, `unattachedLossDb` and `unattachedCost`; it is in none of `totalM`, `lossDb` or `cost`,
and a circuit that was built with one leg warns, naming the provider. The light never enters it, so it
is not a purchase. A segment on `leg: "both"` that is attached is one lease used twice: `onBothLegs`
says so and `totalM` counts it once. A site off the graph, a leg beyond the optic's reach or an overload
is `ok: false` with a reason naming the leg; a body without two sites, or a leased segment
with no `lossDb`, is a 400. See [AUTO-DESIGN.md](AUTO-DESIGN.md#site-to-site-links-dc-to-dc).

## Design calculations

```
POST /api/projects/:id/budget   { ontId?, direction?, marginDb?, wavelength? }
  → { budgets: [ { ont, name, result } | { ont, name, error } ] }

GET  /api/projects/:id/bom       → { lines: [...per span], byCable: [...per model], spanCount }
                                   lines[]   { span, from, to, cable, fiberCount, bundles, routeM, designM }
                                   byCable[] { model, label, fiberCount, designM, lengths, drumM, drums, purchaseM, spareM }
GET  /api/projects/:id/strands   → { rows: [...per span], totalStrands, totalUsed, utilisation, overbooked }

POST /api/design/budget          { design: { olt, ont, spans, splitters, splices, connectors, ... } }
POST /api/design/length          { routeM, overlengthPct?, splices?, closures?, drumM? }
                                 or { points: [{lat, lon}, ...], ... }
GET  /api/design/splitter?ratio=8 → { ratio, idealSplitLossDb }
```

A span is one route but not always one cable: `bundles` is how many cables run it, and auto-design sets
it above one when the fibres a span carries do not fit the largest cable in the ladder. `routeM` stays
the measured route and `designM` is what is bought for **every** cable in the bundle, so a 1.2 km span
with `bundles: 2` prices 2.4 km of that cable. The strand page counts the same capacity: 18 strands on
a 2 × 12 span is three-quarters full, not overbooked.

`/api/design/budget` runs the **PON** budget and nothing else: it calls `budget.opticalBudget`, so
`design.olt.model` is required. A design with no OLT model — including a point-to-point body of
`{ headEnd, cpe }` — is a `400` naming the missing field (`{"error":"design.olt.model is required"}`),
not a `500` and not a link budget. Point-to-point is `POST /api/design/link` (§ Site-to-site links),
which calls `budget.pointToPoint` per leg; there is no endpoint that budgets `headEnd`/`cpe` from a
hand-written body.

A budget `result` carries: `verdict` (`ok`/`marginal`/`fail`), `reasons`, `rxPowerDbm`,
`headroomDb`, `odnLossDb`, `budgetDb`, `classHeadroomDb`, `cascadeRatio`, `wavelength`, `direction`
and `breakdown` (one line per loss element). See [SPEC.md](SPEC.md) §2–3.

`attenuator` is `null` when the receiver is at or below its overload point, and otherwise
`{ overDb, padDb, maxPadDb, atTxDbm, fits }` — how far above overload the receiver lands with the
transmitter at `atTxDbm` (its `txPowerDbmMax` unless the request pinned `txDbm`), the smallest whole-dB
inline pad that clears it, the most pad the margin and class budget can absorb, and whether `padDb`
is achievable. A pad is fitted once, so it is sized for the strongest launch the transmitter can
present, not the weakest. The overload reason quotes the pad and its launch, so `reasons` alone is
enough to act on.

## Printed plan and PNG

```
GET /print/project/:id      → text/html: the plan, the cable to buy, the splice schedule, the checks
```

This is the page a crew takes to site. It carries the drawing with a **scale bar and its `1 px = … m`
figure**, the validation errors and warnings as they stand, the cable-to-buy table (per model and per
span), and a splice schedule for every closure and splitter: each strand on each touching cable, the
engine's TIA-598 address and colour, and how it is terminated — the strand it is spliced to at a
closure, `parked` when it arrives on one cable and leaves on none, or `splitter input` / `splitter
port P<n>` at a splitter, whose rows are never spliced across the split. The browser's own **Print → Save as PDF** is the PDF path; nothing is
rendered into a PDF on the server and no library is loaded.

Everything the page prints is HTML-escaped, and the page contains no `<script>` and no remote
`src`/`href`, so it renders on a machine with no network. An unknown id answers a **404 HTML page**.
A project whose cable models cannot be priced still prints: the cable section names the error
(`Cable to buy unavailable: …`) instead of the page turning into a 500.

The PNG of the drawing is made in the browser from the same SVG the canvas shows, at 2× (1800 × 1120
device pixels for the 900 × 560 canvas). Its metres-per-pixel figure comes from `scene.exportPlan` —
`metresPerPixel / zoom`, so 0.5 m/px on screen is 0.25 m per exported pixel at 2× — and that
arithmetic is asserted in `test/print-export.test.js`, not checked by eye.


## Import

```
POST /api/import/kml      body: KML text, or a KMZ buffer with Content-Type: application/vnd.google-earth.kmz
  → { name, routes: [{ name, points, lengthM, ends }], points: [{ name, lat, lon }],
      skipped: [...], duplicates, routeM, unsupported }
```

Nothing is written: the caller decides which routes and points become spans and nodes.

## Static

```
GET /            → web/index.html
GET /fiber.js    → engine/fiber.js, so the UI colours a strand from the engine's own table
GET /<file>      → web/<file>, from a whitelist of extensions
```

No authentication, by design — see [SECURITY.md](../SECURITY.md).
