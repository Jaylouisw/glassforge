# HTTP API

Everything the UI does goes through these endpoints, so anything the UI can do can be scripted.
All responses are JSON unless noted. Errors are `{ "error": "..." }` with `400` (bad input), `404`
(unknown thing) or `405` (wrong method); a `500` means the server broke, not that your design is wrong.
A body over the limit is a **`413` naming the limit** — 2 MiB (`2097152` bytes) for a project write,
`/api/projects/:id/budget`, `/api/design/budget` or `/api/design/length`, and 25 MiB for the five
endpoints that carry a demand list or a street/duct graph: `/api/design/synthesise`, `/api/design/link`,
`/api/import/demand`, `/api/import/network` and `/api/import/kml`. It is answered with `Connection: close`
**once the body has finished arriving** — the server keeps reading the rest and throws it away, because a
refusal written while megabytes of the upload are still in flight closes the socket with data in its
receive buffer, and the kernel answers the remainder with RST: the caller then discards the 413 it was
just sent and reports `ECONNRESET`. Wait for the answer; do not half-close the request.

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
    parts: { total: 141, byKind: { cable: 34, splitter: 14, olt: 17, ont: 12, transceiver: 32,
                                  closure: 15, connector: 15, splice: 2 } },
    projects: 0, uptimeS: 3 }
```

`version` is `package.json`'s. `parts.total` and `parts.byKind` are the catalogue on disk, so they
change whenever a part is added. The block above is a **snapshot, not a contract**: re-recorded on
`main` at `2214340` (after the one-port GPON root, gh#231, and the four Nokia ONTs, gh#234 and
gh#241) on 2026-11-28, it is illustrative and will drift as the catalogue grows. The authorities are
the endpoint itself and `node scripts/count-parts.js`, whose `--check` mode keeps README's copy of
that line honest — re-record the block with the command below, never by editing the numbers by hand.

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

A node is placed at `lat` **and** `lon`, or at neither: `null` on both is the legitimate "not placed on a
map yet" state, and half a pair would be drawn at the centre of the canvas rather than where the node is.
The edit enforces the pair where the value is still visible, so each of these is a `400` on the edit
itself, not an error surfaced by the next `GET`:

- `lng` is refused by name rather than dropped: `node.lng is not a field this model reads - did you mean
  "lon"?` A node is placed at `lat` and `lon`; a longitude under the key most map libraries use was
  stored as a node with no longitude and answered `200`.
- one axis without the other — `add-node` with `lat` alone or `lon` alone, and an `update-node` patch
  that sets one axis of an unplaced node: `node "n1" is placed with a latitude and no longitude - lat and
  lon are one placement (null on both means "not on a map yet"), so a node is placed at both or neither`.
  `{ "lat": null, "lon": null }` is still how a node is taken off the map.
- a coordinate that is not a number in range: `lat: "51.5"` → `node.lat must be a number between -90 and
  90, got "51.5"`; `lat: 91` → `... got 91`. `move-node` applies the same rule to both axes (`move-node.lat
  must be a number between -90 and 90, got 999`).
- `PUT` and a hand-edited file reach the same rule through `network.validate`, so a project stored with
  `lat` and `lon: null` is refused with the "a node is at both or neither" sentence; `null` on both is
  not a coordinate error.

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
    network?, maxSnapM?, joinToleranceM?, ladder?, overlengthPct?, kmeansIterations?,
    pon?: { ratios, olt, ont, maxDropM },
    active?: { headEndOptic, cpeOptic, optics: [{ headEndOptic, cpeOptic }] },
    costs?, applyToProject? }
  → { ok, demand, headEnd, objective, routeMethod, technology, best, candidates, plant, runs,
      rationale, notes, applied? }

POST /api/import/network
  body: KML text, a KMZ buffer, or { edges: [{ coords }] }
  → { stats: { nodes, edges, duplicates, lengthM, lengthKm }, edges: [{ id, lengthM, coords }] }

POST /api/import/demand
  { demand: "label,lat,lon\n..." }            (or an array of rows)
  → { points, rejected, duplicates, meta, bbox }
```

`stats.duplicates` counts edge additions that were the same drawing as an edge already in the graph and
were merged into it — a road drawn whole plus the halves, or one KMZ exported twice — so a caller
comparing what it sent with the graph it got back can see where a segment went. A normal import answers
`duplicates: 0`; the field is always present. Nothing is lost silently: the same road drawn whole plus
its two halves answers `edges: 2, duplicates: 2`.

`demand` is CSV text or an array of `{ label?, address?, lat, lon }`. Rows without coordinates are
refused by row number — geocoding is off by default — and the answer carries that parse's summary
beside the design: `demand` is `{ points, rejected, duplicates, meta, bbox }`, where `points` is the
**count** of usable points the design was built from (a number, not the point array
`POST /api/import/demand` returns), with every refused row as `{ row, reason, text }` and `row` the
1-based line of the input, header included. A file whose lines 3 and 4 are missing a cell still answers a
design for the one point that parsed (`demand.points: 1`) with both refusals named; one
where nothing parsed is a `400 no usable demand points: 2 row(s) rejected (latitude or longitude
is empty)`, never an empty plant. `headEnd` is the site the request named, echoed unchanged.

`bbox` is the smallest box covering the points. Its longitude side crosses the antimeridian when the
points straddle 180 deg: **`minLon > maxLon` means the box runs east from `minLon`, through 180, to
`maxLon`**, so its width is `lonDelta(minLon, maxLon)` and membership is
`lonDelta(minLon, lon) <= lonDelta(minLon, maxLon)` rather than a raw `min <= lon <= max`. Two houses at
179.9 and -179.9 are a 0.2 deg box, not a 359.8 deg one; a box that does not cross keeps
`minLon <= maxLon` exactly as before. No endpoint returns a centre: `engine.demand.prepare` computes
one, but it is not on the wire, so a caller that wants it averages `points` from
`POST /api/import/demand` itself.
`network` switches the router from the straight-line factor to a street/duct graph;
`/api/import/network` builds that graph and hands it back so the caller can preview it (and send it as
`network` unchanged). `applyToProject` replaces the project's plant in one operation (one undo step)
*after* validating it; without it, the design is returned and nothing is written. Candidates that fail
are returned with `feasible: false` and their reasons, never dropped. Every
candidate carries `budgets`, one row per ONT (`{ ont, name, verdict, marginalReason, headroomDb,
rxPowerDbm, launchWindowPad, upstreamVerdict, upstreamRxPowerDbm, error }`), and `metrics.marginalOnts`
counts the ONTs that pass only marginally; the chosen design's `warnings` names the tightest one once for
the whole plant. Both directions are budgeted: `verdict` is downstream (OLT → ONT, 1490 nm), the
`upstream*` columns are the ONT into the OLT at 1310 nm, and `metrics.upstreamFailOnts` counts the rows
that fail there — reported in the winner's `warnings`, but it does not move `feasible`, which is still
the downstream verdict — see [AUTO-DESIGN.md](AUTO-DESIGN.md#reading-a-result).
With `costs`, `objective` is `cost` and every candidate's `metrics.cost` prices the drums the BOM buys
(`purchaseM`) plus the priced splices, closures and splitters, with the terms in
`metrics.costBreakdown: { cable, splices, closures, splitters, total }`; without `costs`, both are
`null`.

`costs` is a price list, and a term it leaves unsaid is **refused by name**, never charged as zero:
`cablePerM` has to name every cable model the design builds with, and `splice`, `closure` and
`splitter` have to be present whenever a candidate builds that term. A demand priced on one cable model
is a `400` naming the models it is missing:

```
$ curl -s -X POST http://127.0.0.1:8000/api/design/synthesise -H 'Content-Type: application/json' \
    -d '{"demand":"label,lat,lon\nCasa 1,51.5000,-0.1000\nCasa 2,51.5005,-0.0998",
         "headEnd":{"lat":51.4985,"lon":-0.1004}, "costs":{"cablePerM":{"g652d-loose-12":2}}}'
HTTP 400
{"error":"costs.cablePerM has no price for g657a2-drop-1, g657a2-drop-2 - a money objective that treats an unpriced cable as free ranks the wrong design; price every cable the design builds with, or omit costs to rank by fibre-metres"}
```

With every cable priced but no labour terms, the refusal names `costs.closure, costs.splice and
costs.splitter are not priced, and a design here builds them - a money objective that charges an
unsaid term as 0 quotes a total short of what the design costs, so price the term or write 0 to say it
costs nothing; omit costs to rank by fibre-metres`. `0` is a figure the ranking can use — it says the
term is free — and a term a candidate never builds needs no price at all, so an `active` request on a
model with no `splitter` entry answers `200` while the same body with `"technology":"pon"` is the
`costs.splitter is not priced` refusal. See [AUTO-DESIGN.md](AUTO-DESIGN.md#why-fibre-metres-not-metres).

`ladder` and `overlengthPct` are the two knobs that change what is bought rather than where it goes: the
ladder is the cable list every span is chosen from, and `overlengthPct` (default 3) is the BOM slack quoted
on every route. A present-but-unreadable value is a `400`, never a default, because either one silently
reshapes the whole plan: the same eight-house estate quotes 707.3 m of design length at the default and
755.4 m at `{"overlengthPct":10}` (707.3 / 1.03 x 1.10 = 755.4), while `{"overlengthPct":"ten"}` is
`the design reads "overlengthPct" as a percentage of design length and got "ten" (a string)` and
`{"ladder":["nope"]}` names the cable models the catalogue has.

`kmeansIterations` (default 8, a whole number ≥ 1) is the number of assignment/re-centring passes the PON
clusterer runs before it places splitter sites. It changes the plant, not a label: on the thirteen-house L
the design tests use, one pass leaves the 1:8 candidate on 4 splitter sites and 14,812.2 fibre-metres,
while two or more passes contract it to 2 sites and 13,555 - a different design and, on the default
objective, a different ranking. Zero or fewer is refused because the assignment never runs: the candidate
would carry no ONT and win the ranking on 0 fibre-metres (`... and the candidate is a plant with no ONT,
ranked feasible on 0 fibre-metres`). A fraction is refused too - the loop runs `iteration < maxIterations`,
so 1.5 would mean two passes nobody chose - and `"3"`, `null`, `true` are refused by name rather than
defaulted, like every other present-but-unreadable option. See
[AUTO-DESIGN.md](AUTO-DESIGN.md#pon).

`pon` and `active` are blocks of named options, and a block of another shape is a `400` rather than a
substitution. The blocks are merged into the defaults, so a value the design cannot read used to be
*replaced* and the search then ran on options nobody named: `{"pon":"gpon"}` answers `the design reads
"pon" as an object of ratios, olt, ont, maxDropM and got "gpon"`, and `{"pon":{"ratios":"16"}}` is refused
rather than iterated by character - a string is iterated, so `"16"` would try 1:1 and 1:6 and then answer
"no candidate topology could be built", the estate blamed for a missing pair of brackets. A near-miss key
inside a block is refused the same way (`{"pon":{"ratio":[8]}}` names `ratios`). `active.optics` is a list
of `{ headEndOptic, cpeOptic }` pairs, and an end may be named once for the whole block instead:
`{"technology":"active","active":{"headEndOptic":"sfp-1g-lx-10km","optics":[{"cpeOptic":"sfp-1g-lx-10km"}]}}`
builds the 1G plant (541.4 m). An entry that names an end nowhere is refused, because that end used to be
filled from the default and the ONTs then failed as "the optics run at different rates". Only the block
the chosen `technology` reads is validated: a `pon` block beside `technology: "active"` is not a setting,
and it is neither read nor refused.
See [AUTO-DESIGN.md](AUTO-DESIGN.md).

## Site-to-site links

```
POST /api/design/link
  { sites: { a: { name?, lat, lon }, b: { name?, lat, lon } },
    optics: { a: transceiver model, b: transceiver model },
    network?: KML text | [polylines] | { edges: [{ coords }] },
    protection?: "diverse" (default) | "single",
    direction?: "down" (default) | "up",
    thirdParty?: [{ provider, lengthM, lossDb, leg?: "a"|"b"|"both", cost?, reference? }],
    fibres?, cable?, ladder?, connectors?, splices?, splicesPerJoint?, closure?, marginDb?,
    splitters? (read only to be refused), maxSnapM?, joinToleranceM? }
  → { ok, mode: "link", technology, routeMethod, network, sites, protection, legs, paths, runs,
      diversity, thirdParty, bom, verdict, upstreamVerdict, reasons, warnings, notes }
```

The options are read through a fixed list, and a **near miss is a 400 naming the field**. A key the
link does not read is not a setting it rejected - it is not a key at all, so the default ran and the
answer looked complete: on the grid in `test/link-design.test.js` (1164.22 m of leg) `{"overlengthpct":10}`
answered `designM` 1199.15 - the 3% default, **81.49 m of cable short** against the 1280.64 the caller's
10% buys - and `{"marignDb":10}` budgeted both legs at the 3 dB reserve, where 10 dB turns their 10.39
and 10.37 dB of headroom from `ok` into `marginal`. The rule is the budgets' rule (`LINK_OPTION_FIELDS`
in `engine/link.js`: case, singular/plural, a prefix, one letter wrong, a swapped pair) so a caller's
`name` and `notes` still pass; it names the option it read and the one that was meant.

`splitters` is the one option on that list the link **reads only to refuse**. A circuit is two optics
and fibre, and a splitter is a PON element, so a design carrying one is a contradiction, not a setting.
It is on `LINK_OPTION_FIELDS` so that a singular `splitter` is a near miss of it and named as one, and a
`splitters` key with content is a `400` - `{"splitters":[{"model":"plc-1x8-sca"}]}` answers `the link
design reads "splitters" and refuses it: a link is two optics and fibre, and a splitter is a PON
element, so this design puts 1 splitter (plc-1x8-sca) on a circuit that cannot be built. … Drop the key,
or budget the PON with POST /api/design/budget, which charges a splitter.` An absent key, `null` or `[]`
is "no splitter" and still designs. Measured on `main` at `5443234`, the same request answered `200`,
`ok: true`, with leg `odnLossDb` 1.067 dB and no splitter in the BOM: the 10.50 dB part was in neither
the loss nor the bill, which is why the key is refused now rather than dropped.

Two named sites and an optic at each end, with **both legs routed along the supplied duct/street
graph** — there is no straight-line fallback while a graph is present. With `protection: "diverse"` the
legs are the minimum-cost edge-disjoint pair (Suurballe) where the graph allows one; where it does not,
the second leg is the path that shares the fewest metres and `diversity.shared` names every shared
segment with its metres (`diversity.sharedM` is `null` when there is only one leg: there is nothing to
compare). **0 m shared is not the same claim as diverse**: two legs can share no duct at all and still
pass through one chamber, so `diversity.sharedNodes` lists every interior vertex on both legs as
`{ nodeId, lat, lon }` (`sharedNodeCount` repeats the length; the two sites are excluded, since every
leg starts and ends at them) and `protection.achieved` requires the list to be empty. The sentence
carries it in words - `no duct is shared, but both legs pass through 1 shared joint node
(51.500000,-0.099000): one failure in that chamber takes out both legs` - and names a chamber by
coordinate, because a vertex id is `planarize`'s numbering, not something on the drawing. Each leg carries its own `budget` from `budget.pointToPoint`, so reach, loss
budget and overload are three verdicts per leg. `direction` picks which half of the circuit
`budget` and `verdict` describe (default `"down"`, A launching into B); any value other than
`"up"`/`"down"` is a 400, because the two directions are different receivers at different
wavelengths and refusing beats reading a typo as `"down"`.
**A circuit is two links over that one path**, so each leg also carries `upstream` - a second
`pointToPoint` call with `direction: "up"`, always the B → A direction whatever `direction` asked for,
and the same object as `budget` when the caller asked for `"up"` - with its own `upstreamVerdict`;
the top-level `upstreamVerdict` is the worst of the legs, and it is `null` on a refusal, which routed
nothing and so measured neither direction. The half not asked for is **warned about, not gated**: a
failing `upstream` adds `A-leg: fails upstream over the same path - <reasons>`, naming the one pad
to buy when both directions ask for one, but `verdict` and `ok` stay the direction the caller asked
for - the same treatment auto-design gives `upstreamVerdict` / `metrics.upstreamFailOnts`, and
whether an upstream failure should refuse a circuit is open in #6 (the upstream verdict) / #5 (the
launch-window verdict). A mixed pair is not symmetric: `sfp-1g-lx-10km` at A and `sfp-1g-ex-40km` at
B over a 3.0 km duct read `ok` downstream at -12.65 dBm and `fail` upstream at -2.65 dBm, because
the EX launches its floor into the LX receiver's -3 dBm overload point: a 5 dB pad, not more reach.
`legs[].routedM` is the graph measurement,
`legs[].ownM` adds both site drops (the cable to buy) and `legs[].lengthM` adds leased segments.
`legs[].spliceEvents` is what the light crosses - one splice per joint on the leg, or the `splices`
option - and is what each leg's budget charges; `legs[].splices` is the crew's count, that number times
`splicesPerJoint` (default `fibres`), and `bom.splices` sums it. A 24-fibre leg through one joint is one
splice event and 24 splices to perform.
`closure` is the model the BOM orders at every interior joint, and it was the one option this endpoint
**echoed instead of read**: `{"closure":"mufa-inline-99"}` answered `200`, `ok: true`, with a part
nobody makes in `bom.closures.model`, and a 48-fibre leg through one joint billed a 24-splice mufa in
silence. A model the closure catalogue does not have is now a `400` naming the models that exist; a
closure too small for the splices made in it — `splicesPerJoint`, one joint's worth — is a `warnings`
entry instead of a refusal, naming the inline closures that hold them (`closure "mufa-inline-24" would
carry 48 splices, capacity 24 … fosc-600c-inline-216 (216)`), because the plant reports the same
overrun as a note and the larger closure is a substitution, not a redesign. A leg with no interior
joint buys no closure and is never challenged: 2 splices in a 24-splice mufa is silent.

`ladder` is the list of cable models a leg is bought from, and it is checked before anything is
routed: a bare model name, or a model the cable catalogue does not have, is a `400` naming `ladder`
and its position, never a silent fall back to the default ladder. The ladder is the BOM, and the
circuit it quotes is a purchase order, so a shape the engine cannot read is refused even when every
leg is short enough for drop cable.
A leased segment that rides a leg this circuit built is charged to that leg's budget and to the cost,
and is never in `bom.cableM` (`bom.thirdParty.inCableBom === false`). A segment assigned to a leg that
was not built — `leg: "b"` under `protection: "single"`, on a circuit the graph only gave one route, or
on a request where routing failed — is still listed, with `attached: false`, and summed in
`unattachedM`, `unattachedLossDb` and `unattachedCost`; it is in none of `totalM`, `lossDb` or `cost`,
and a circuit that was built with one leg warns, naming the provider. The light never enters it, so it
is not a purchase. A segment on `leg: "both"` that is attached is one lease used twice: `onBothLegs`
says so and `totalM` counts it once. A site off the graph, a leg beyond the optic's reach or an overload
is `ok: false` with a reason naming the leg; a body without two sites, or a leased segment
with no `lossDb` or a `cost` that is not a non-negative number, is a 400. `cost` is optional and
unitless; absent means unpriced (`cost: null`, `costComplete: false`), `0` is a stated price, and a
present `cost` that arrived as text or negative is refused rather than read as unpriced.
See [AUTO-DESIGN.md](AUTO-DESIGN.md#site-to-site-links-dc-to-dc).

## Design calculations

```
POST /api/projects/:id/budget
  { ontId?, direction?, wavelength?, connectorModel?, spliceModel?, allowanceDb?, marginDb?, txDbm? }
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

`/api/projects/:id/budget` hands the body to `designForOnt` as its options, and **eight** keys are what
it reads: `ontId` narrows the answer to a single ONT, `direction` (default `down`) and `wavelength`
(1490 down, 1310 up) choose the receiver, `spliceModel` (default `fusion`) and `connectorModel`
(default `sc-apc`) set the loss each splice and each connector is charged at, `marginDb` (default 3) is
the reserve the verdict requires, `allowanceDb` (default 0) is extra design reserve **added to the
ODN loss**, and `txDbm` is the launch power to budget at (default: the transmitter's minimum).
`allowanceDb` is the one a planner reaches for on a project: it changes no plant, it makes the
verdict account for slack the route has not spent — the result echoes `marginDb`, and `totalLossDb`
carries the allowance (`odnLossDb` 11.86 + 2 for `{"allowanceDb":2}`). The worked example is a project
of one `gpon-b-plus-8`, one `plc-1x8-sca` splitter, one `gpon-ont-1ge` and 3 km of `g652d-loose-12`,
with a 1 m `g657a2-drop-1` drop, driven through `network.allOntBudgets` — the call the endpoint makes.
`test/api-doc-budget-example.test.js` re-drives it, so a figure that moves in a part file has to move
here too:

```
{}                            odnLossDb 11.86  totalLossDb 11.86  rxPowerDbm -10.36  headroomDb 16.64  classHeadroomDb 16.14  txDbm 1.5  sensitivityDbm -27  verdict ok
{"allowanceDb":2}             odnLossDb 11.86  totalLossDb 13.86  rxPowerDbm -12.36  headroomDb 14.64  classHeadroomDb 16.14  txDbm 1.5  sensitivityDbm -27  verdict ok
{"spliceModel":"mechanical"}  odnLossDb 12.06  totalLossDb 12.06  rxPowerDbm -10.56  headroomDb 16.44  classHeadroomDb 15.94  txDbm 1.5  sensitivityDbm -27  verdict ok
{"connectorModel":"lc-apc"}   odnLossDb 11.76  totalLossDb 11.76  rxPowerDbm -10.26  headroomDb 16.74  classHeadroomDb 16.24  txDbm 1.5  sensitivityDbm -27  verdict ok
{"txDbm":7}                   odnLossDb 11.86  totalLossDb 11.86  rxPowerDbm -4.86  headroomDb 22.14  classHeadroomDb 16.14  txDbm 7  sensitivityDbm -27  verdict fail  attenuator.padDb 4
```

`{}` is -10.36 dBm at the launch the budget defaults to — the transmitter's minimum, +1.5 dBm — and
`headroomDb` is that receive power less the receiver's sensitivity: -10.36 - (-27) = 16.64. The
`gpon-ont-1ge` receiver is -27 dBm, not the -30 dBm of a `gpon-ont-4ge`, which is what an example that
names no ONT left a reader to guess. `marginDb` is compared against headroom rather than subtracted
from it: a 3 dB margin on that answer still leaves 16.64 dB of headroom, 13.64 dB of it spare, and the
row reports the larger figure, not the net. `{"spliceModel":"mechanical"}` adds 0.2 dB at the
splitter's splice (0.3 dB a splice against fusion's 0.1), and `{"connectorModel":"lc-apc"}` takes
0.05 dB off each of the two connectors.
`txDbm` is the same launch the design budget reads, and it moves the verdict because the overload point is judged at it:
the same project's `{}` is -10.36 dBm at +1.5 dBm, inside the ONT's -8 dBm overload point, while
`{"txDbm":7}` answers `rxPowerDbm` -4.86 and `fail` - 3.14 dB over that point, so `attenuator.padDb` is
4. A launch the budget cannot read is not a launch: it is refused rather than dropped.

`wavelength` is checked against `direction`, because the ODN loss is wavelength-specific and a pair no
PON carries quotes a loss the link never sees: a PON transmits downstream at 1490 nm (1550 for an RF
overlay) and upstream at 1310 nm, so `{"direction":"up","wavelength":"1550"}` is a `400` -
`upstream is budgeted at 1310 nm, not 1550 nm …` - and not an upstream verdict computed at 1550 nm.
The difference is a verdict: the same 16 km GPON B+ plant through a 1:64 is `fail` upstream at 1310 nm
(headroom 1.40 dB) and would have been `marginal` at 1550 nm (3.64 dB). A wavelength the budget cannot
read (`""`, `0`, `"1550 "`) is refused by the same check instead of falling through to the default, and
the check runs once per request, so an impossible pair is one 400 rather than a 200 whose every row
repeats it. An **active** plant is not bound by it: a single-fibre circuit runs both directions at its
optic's own wavelength, which `pointToPoint` enforces separately.

`direction`, `marginDb`, `allowanceDb` and `txDbm` are checked once, before any ONT is budgeted: a value
that is present and unusable is a `400` naming the field (`{"allowanceDb":-1}`, `{"marginDb":"3"}`,
`{"direction":"sideways"}`, `{"txDbm":"7"}`), never a `200` whose every row repeats the same complaint.
A launch outside the module's own window is not a mistake - it is budgeted and answered with a warning
naming the range - so only a value that is not a number is refused.
`spliceModel` and `connectorModel` are looked up per ONT instead, so an unknown model answers a row `{ ont, name, error }`
naming the models that exist — `unknown splice model "nope" - known models: fusion, mechanical` — because
a missing figure stays missing, and the rest of the plant is still budgeted.

`/api/design/budget` runs the **PON** budget and nothing else: it calls `budget.opticalBudget`, so
`design.olt.model` is required. A design with no OLT model — including a point-to-point body of
`{ headEnd, cpe }` — is a `400` naming the missing field (`{"error":"design.olt.model is required"}`),
not a `500` and not a link budget. Point-to-point is `POST /api/design/link` (§ Site-to-site links),
which calls `budget.pointToPoint` per leg; there is no endpoint that budgets `headEnd`/`cpe` from a
hand-written body.

The design object is read through a fixed list of fields, and a **near miss is refused**. A key the
engine does not read is a typo, and it is the worst kind: it removes the loss it names without removing
a number from the plan. A 1:8 splitter sent as `splitter` (singular) budgeted a 15 km GPON B+ ODN at
4.3 dB instead of 14.8 dB and answered `200`.

```
$ curl -s -X POST http://127.0.0.1:8000/api/design/budget -H 'Content-Type: application/json' \
    -d '{"design":{"olt":{"model":"gpon-b-plus-8"},"ont":{"model":"gpon-ont-1ge"},
         "spans":[{"lengthM":1200,"cable":"g652d-loose-12"}],"splices":2,
         "splitter":{"model":"plc-1x8-sca"}}}'
HTTP 400
{"error":"the PON budget does not read the design field \"splitter\" - did you mean \"splitters\"? A field the engine ignores loses the loss it names without saying so, so a near miss is refused rather than skipped. Fields it reads: direction, wavelength, olt, ont, spans, splices, spliceModel, connectors, connectorModel, splitters, thirdParty, allowanceDb, marginDb, txDbm"}
```

The refusal is deliberately narrow: it fires on a case difference, a singular/plural, a prefix of a
real field (`margin` for `marginDb`), one letter wrong, or a swapped adjacent pair (`marignDb` for
`marginDb` — one keystroke is one edit), and names the field that was meant. Every
other key is still ignored — `name`, `notes` or a caller's own bookkeeping passes through untouched,
because a guard that refused every unknown key would refuse a caller who is not wrong.
`budget.pointToPoint`, the **active** budget, refuses the same way against its own list (`headEnd`,
`cpe`, `spans`, `splices`, `spliceModel`, `connectors`, `connectorModel`, `splitters`, `thirdParty`,
`allowanceDb`, `marginDb`, `wavelength`, `direction`, `txDbm`). `splitters` is on that list because the
active budget really does meet the key - to refuse it - so a singular `splitter` is a near miss of
`splitters` and names it rather than suggesting nothing: `budget.pointToPoint({ headEnd: { model:
"sfp-plus-10g-lr-10km" }, cpe: { model: "sfp-plus-10g-lr-10km" }, splitter: { model: "plc-1x8-sca" }
})` answers `the active budget does not read the design field "splitter" - did you mean "splitters"?
… Fields it reads: direction, wavelength, headEnd, cpe, spans, splices, spliceModel, connectors,
connectorModel, splitters, thirdParty, allowanceDb, marginDb, txDbm`. No endpoint hands a caller's body
to it, since `/api/design/link` builds that design from its own named options, so over the HTTP surface
the near-miss refusal is the PON budget's; the link's own option list is guarded separately (§
Site-to-site links).

A `splitters` key with content is refused outright - not read, and not dropped from the loss and the
bill: `the active budget does not read "splitters": an active link is two optics and fibre, and a
splitter is a PON element, so this design puts 1 splitter (plc-1x8-sca) on a network that cannot be
built. … Remove the splitters, or budget the PON they belong to with opticalBudget.` An absent key,
`null` or `[]` is "no splitter" and budgets normally, so a form that always sends `splitters: []` is
not wrong - it is how the PON budget and the active budget share one form.

`/api/design/length` reads nine options — `routeM`, `overlengthPct`, `splices`, `spliceReserveM`,
`closures`, `closureReserveM`, `dropReserveM`, `drumM`, `minimumPurchaseM` — and refuses a near miss
of one by the same rule, because its answer is a purchase order. `{"routeM":1000,"drumm":500}` answered
`200` with `drumM: 2000, drums: 1`: 2000 m bought where 3 × 500 m was asked. `{"overlengthpct":10}`
answered `designM` 1030 — the 3% default — instead of 1100, so 70 m of overlength were missing from the
order, and a singular `{"closure":2}` dropped both 20 m closure reserves. Each is now a `400` naming the
field that was meant — `the cable calculation does not read the option "drumm" - did you mean "drumM"? …`
— on both forms of the endpoint, since the drawn route ends in the same calculation. The guard is as
narrow here as it is on a budget: `name`, `notes` and the route form's own `points` pass through, and a
correctly spelled option still answers.

A budget `result` carries: `verdict` (`ok`/`marginal`/`fail`), `reasons`, `warnings` (sentences that
do not move the verdict; the launch-window band
[OPTICAL.md](OPTICAL.md#the-band-between-the-two-launches) describes is the one an ordinary estate
carries), `rxPowerDbm`, `headroomDb`, `odnLossDb`, `budgetDb`, `classHeadroomDb`, `cascadeRatio`,
`wavelength`, `direction`, `marginalReason`, `attenuator`, `launchWindowPad` and `breakdown` (one line per
loss element). See [SPEC.md](SPEC.md) §2–4.

`marginalReason` is the sentence a `marginal` verdict used to lack: it names the figure that is tight and
only that figure — `headroom 3.22 dB is only 0.22 dB above the 3 dB design margin (sensitivity -27 dBm)`,
`only 0.62 dB of the GPON B+ budget of 28 dB is left`, or both, joined with `, and `. It is `null` for
`ok` (nothing to explain) and for `fail` (its `reasons` name the fault and the fix, and a failure dressed
as marginal would soften a refusal).

`attenuator` is `null` when the receiver is at or below its overload point, and otherwise
`{ overDb, padDb, maxPadDb, atTxDbm, fits }` — how far above overload the receiver lands with the
transmitter at `atTxDbm` (its `txPowerDbmMax` unless the request pinned `txDbm`), the smallest whole-dB
inline pad that clears it, the most pad the margin and class budget can absorb, and whether `padDb`
is achievable. A pad is fitted once, so it is sized for the strongest launch the transmitter can
present, not the weakest. The overload reason quotes the pad and its launch, so `reasons` alone is
enough to act on.

`launchWindowPad` is the other half: when the receiver is inside its overload point at the floor of the
transmitter’s window but over it at the ceiling, `attenuator` is `null` and this carries the pad the band
needs, in the same shape, sized at the top of the window. The two are never both set, the verdict is not
moved by it, and `warnings` says which launch overdrives the receiver — see
[OPTICAL.md](OPTICAL.md#the-band-between-the-two-launches).

## Printed plan and PNG

```
GET /print/project/:id      → text/html: the plan, the cable to buy, the splice schedule, the checks
```

This is the page a crew takes to site. It carries the drawing with a **scale bar and its `1 px = … m`
figure**, the validation errors and warnings as they stand, the cable-to-buy table (per model and per
span), and a splice schedule for every closure and splitter: each strand on each touching cable, the
engine's TIA-598 address and colour (cable-qualified, `C02/T01-F06`, on a bundled span — SPEC §6), and
how it is terminated — the strand it is spliced to at a
closure, `parked` when it arrives on one cable and leaves on none, or `splitter input` / `splitter
port P<n>` at a splitter, whose rows are never spliced across the split. The browser's own **Print → Save as PDF** is the PDF path; nothing is
rendered into a PDF on the server and no library is loaded.

The **Checks** section opens its budget warnings with one plant-level sentence about the OLT's launch
window, built by `budget.launchWindowNote` — the same sentence a synthesised design puts in its
`warnings`, so the page a crew signs off and the report that chose the design cannot disagree about it.
It states the share of the estate in the band and the pad to buy, once, and the per-ONT warnings stay
underneath it because a warning names the ONT it is about. A PON is two passes over one ODN, and a pad
is loss in both directions, so the size the note names is the larger of the two and its `padBinds`
says which direction set it. Measured on a C+ OLT with a 1:8 cassette 200 m away and two ONTs on
30 m drops - ODN 11.251 dB downstream, 11.281 dB upstream - the line reads:

```
2 of 2 ONTs are inside the overload point only at the bottom of the OLT gpon-c-plus-8 launch window:
worst 3.75 dB over at the 7 dBm top, but the upstream direction is already over the OLT receiver's
overload point at the floor launch, so one pad in this ODN serves both receivers and this plant takes
the larger: 6 dB
```

The note's fields come from that pad - `padDb 6`, `overDb 5.72`, `atTxDbm 5`, `maxPadDb 18` and
`padBinds: "up"` - while the sentence itself keeps the band's own overshoot (3.75 dB at the 7 dBm
top). This plant is not `ok` on both verdicts, and the page does not say it is: the downstream band
is the 4 dB the top of the OLT window asks for, but the upstream pass puts the OLT receiver at
-10.78 dBm against its -12 dBm overload point even at the ONT's +0.5 dBm floor launch, so the same
Checks section opens with an error - `2 of 2 ONTs fail upstream at the OLT receiver - Casa 1: ...
fit a 6 dB inline pad ...` - and the two sentences name one pad, not two. Fitting the 4 dB the
downstream band alone asks for leaves the OLT receiver 2 dB over at the top of the ONT's window.

One pad at the OLT is only the right purchase when every ONT in the band needs the same size. A band
that needs a 4 dB pad on one drop and a 2 dB pad on another, or an estate with only part of its ONTs in
the band, is answered with `a pad at each of the 2 affected ONTs carries the design to full launch
(1 x 4 dB, 1 x 2 dB)` and, where the rest of the estate is clear, `and the other 1 cannot share a pad on
the feeder`: one pad at the feeder is one size, so it would spend the other ONTs' margin to fix these.
A plant clear of the band prints no such line at all.

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
  → { name, routes: [{ name, points, lengthM, ends, dropped }], points: [{ name, lat, lon }],
      skipped: [...], duplicates, droppedCoordinates, routeM, unsupported }
```

A `lon,lat[,alt]` tuple whose longitude or latitude cell is blank, non-numeric or out of range is
**dropped, never read as 0** — 0 is a legal longitude, so a missing cell would otherwise import as a
phantom bend on the Greenwich meridian and a route length nobody can defend. Every dropped tuple is
counted: `routes[].dropped` for a route that lost a bend, `droppedCoordinates` for the whole file. A
route quotes the length of the points it still has, and a placemark that lost its only coordinate is
reported as `unsupported`, not as an empty route.

Nothing is written: the caller decides which routes and points become spans and nodes.

## Static

```
GET /            → web/index.html
GET /fiber.js    → engine/fiber.js, so the UI colours a strand from the engine's own table
GET /<file>      → web/<file>, from a whitelist of extensions
```

No authentication, by design — see [SECURITY.md](../SECURITY.md).
