# HTTP API

Everything the UI does goes through these endpoints, so anything the UI can do can be scripted.
All responses are JSON unless noted. Errors are `{ "error": "..." }` with `400` (bad input), `404`
(unknown thing) or `405` (wrong method); a `500` means the server broke, not that your design is wrong.

The server binds `127.0.0.1:8000` by default (`HOST`, `PORT`), and stores projects under `GF_DATA`
(default `data/`).

## Health

```
GET /api/health
→ { ok: true, name: "glassforge", version: "0.4.0", parts: { total: 37, byKind: {...} }, projects: 0, uptimeS: 12 }
```

`version` is `package.json`'s version and `parts.total` is the catalogue as loaded, so both move with
the repo. The example above is the response from this tree; nothing in it is hard-coded.

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

A refused operation returns `400` with the reason and leaves the saved project untouched. "Refused"
here means the *operation* cannot be expressed: a second OLT or head-end, an unknown node id, a span
from a node to itself, a span with no cable, a length that is not a positive number.

`/ops` does **not** run the plant validator before it saves. An unknown cable model or an over-split
PON is applied, written to disk and answered `200`; the verdict comes back afterwards in
`derived.errors`, beside the plant. Only `PUT /api/projects/:id` refuses an invalid design with `400`
and its `errors`. That difference between the two write paths is a known inconsistency in the
behaviour, tracked as issue #25 — until it is closed, read `derived.errors` after a `/ops` call before
trusting the saved plant.

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
A leased segment is charged to the budget and the cost and is never in `bom.cableM`
(`bom.thirdParty.inCableBom === false`). A site off the graph, a leg beyond the optic's reach or an
overload is `ok: false` with a reason naming the leg; a body without two sites, or a leased segment
with no `lossDb`, is a 400. See [AUTO-DESIGN.md](AUTO-DESIGN.md#site-to-site-links-dc-to-dc).

## Design calculations

```
POST /api/projects/:id/budget   { ontId?, direction?, marginDb?, wavelength? }
  → { budgets: [ { ont, name, result } | { ont, name, error } ] }

GET  /api/projects/:id/bom       → { lines: [...per span], byCable: [...per model], spanCount }
GET  /api/projects/:id/strands   → { rows: [...per span], totalStrands, totalUsed, utilisation, overbooked }

POST /api/design/budget          { design: { olt, ont, spans, splitters, splices, connectors, ... } }
POST /api/design/length          { routeM, overlengthPct?, splices?, closures?, drumM? }
                                 or { points: [{lat, lon}, ...], ... }
GET  /api/design/splitter?ratio=8 → { ratio, idealSplitLossDb }
```

`POST /api/design/budget` runs `budget.opticalBudget` and nothing else, so the body it takes is the PON
one: `olt.model`, `ont.model`, `spans`, `splitters`, `splices`, `connectors`. An **active-link** body
(`headEnd`/`cpe` instead of `olt`/`ont`) is not handled by this route — it answers
`500 {"error":"design.olt.model is required"}`, because the route never reaches `budget.pointToPoint`:

```bash
curl -s -X POST http://127.0.0.1:8000/api/design/budget -H 'Content-Type: application/json' -d '{
  "design": {
    "olt": { "model": "gpon-c-plus-8" }, "ont": { "model": "gpon-ont-4ge" },
    "spans": [ { "cable": "g652d-loose-24", "lengthM": 1200 },
               { "cable": "g657a2-drop-1", "lengthM": 45 } ],
    "splitters": [ { "model": "plc-1x8-sca" } ], "connectors": 2, "splices": 2 } }'
→ { "ok": true, "verdict": "ok", "odnLossDb": 11.574, "headroomDb": 21.43,
    "cascadeRatio": 8, ... }
```

Drop the connectors and the splices and the same plant fails the *overload* test instead: 10.764 dB of
ODN puts −7.76 dBm on an ONT whose overload point is −8 dBm. Both verdicts are real; neither is
assumed.

An active circuit is budgeted through [`POST /api/design/link`](#site-to-site-links), which gives one
`pointToPoint` verdict per leg. For an active **plant** (a `headend` root in a project),
`budget.pointToPoint` is reached through `engine/network.js` — the project budget route,
`POST /api/projects/:id/budget` — and there is no design-body route for it.

A budget `result` carries: `verdict` (`ok`/`marginal`/`fail`), `reasons`, `rxPowerDbm`,
`headroomDb`, `odnLossDb`, `budgetDb`, `classHeadroomDb`, `cascadeRatio`, `wavelength`, `direction`
and `breakdown` (one line per loss element). See [SPEC.md](SPEC.md) §2–3.

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
