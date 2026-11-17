# HTTP API

Everything the UI does goes through these endpoints, so anything the UI can do can be scripted.
All responses are JSON unless noted. Errors are `{ "error": "..." }` with `400` (bad input), `404`
(unknown thing) or `405` (wrong method); a `500` means the server broke, not that your design is wrong.

The server binds `127.0.0.1:8000` by default (`HOST`, `PORT`), and stores projects under `GF_DATA`
(default `data/`).

## Health

```
GET /api/health
→ { ok: true, name: "glassforge", version: "0.1.0", parts: { total: 32, byKind: {...} }, projects: 0, uptimeS: 12 }
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

## Design calculations

```
POST /api/projects/:id/budget   { ontId?, direction?, marginDb?, wavelength? }
  → { budgets: [ { ont, name, result } | { ont, name, error } ] }

GET  /api/projects/:id/bom       → { lines: [...per span], byCable: [...per model], spanCount }
GET  /api/projects/:id/strands   → { rows: [...per span], totalStrands, totalUsed, utilisation, overbooked }

POST /api/design/budget          { design: { olt, ont, spans, splitters, splices, connectors, ... } }
                                 or { design: { headEnd: { model }, cpe: { model }, spans, ... } } for an active link
POST /api/design/length          { routeM, overlengthPct?, splices?, closures?, drumM? }
                                 or { points: [{lat, lon}, ...], ... }
GET  /api/design/splitter?ratio=8 → { ratio, idealSplitLossDb }
```

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
