# HTTP API

Everything the UI does goes through these endpoints, so anything the UI can do can be scripted.
All responses are JSON unless noted. Errors are `{ "error": "..." }` with `400` (bad input), `404`
(unknown thing) or `405` (wrong method); a `500` means the server broke, not that your design is wrong.
A body over the limit is a **`413` naming the limit** — 2 MiB for a JSON body, 25 MiB for an import
upload — answered with `Connection: close`. Read the refusal and start a new request rather than finish
an upload the server has already refused.

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
    parts: { total: 61, byKind: { cable: 8, splitter: 8, olt: 11, ont: 5, transceiver: 15,
                                 closure: 8, connector: 4, splice: 2 } },
    projects: 0, uptimeS: 4 }
```

`version` is `package.json`'s. `parts.total` and `parts.byKind` are the catalogue on disk, so they
change whenever a part is added. The block above is a **snapshot, not a contract**: recorded on `main` at
`6f46a81` on 2026-11-24, it is illustrative and will drift as the catalogue grows. The authorities are
the endpoint itself and `node scripts/count-parts.js`, whose `--check` mode keeps README's copy of that
line honest — re-record the block with the command below, never by editing the numbers by hand.

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
    network?, maxSnapM?, joinToleranceM?, ladder?, overlengthPct?,
    pon?: { ratios, olt, ont, maxDropM },
    active?: { headEndOptic, cpeOptic, optics: [{ headEndOptic, cpeOptic }] },
    costs?, applyToProject? }
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
written. Candidates that fail are returned with `feasible: false` and their reasons, never dropped. Every
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

`ladder` and `overlengthPct` are the two knobs that change what is bought rather than where it goes: the
ladder is the cable list every span is chosen from, and `overlengthPct` (default 3) is the BOM slack quoted
on every route. A present-but-unreadable value is a `400`, never a default, because either one silently
reshapes the whole plan: the same eight-house estate quotes 707.3 m of design length at the default and
755.4 m at `{"overlengthPct":10}` (707.3 / 1.03 x 1.10 = 755.4), while `{"overlengthPct":"ten"}` is
`the design reads "overlengthPct" as a percentage of design length and got "ten" (a string)` and
`{"ladder":["nope"]}` names the cable models the catalogue has.

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
    fibres?, cable?, ladder?, connectors?, splices?, marginDb?, maxSnapM?, joinToleranceM? }
  → { ok, mode: "link", technology, routeMethod, network, sites, protection, legs, paths, runs,
      diversity, thirdParty, bom, verdict, upstreamVerdict, reasons, warnings, notes }
```

Two named sites and an optic at each end, with **both legs routed along the supplied duct/street
graph** — there is no straight-line fallback while a graph is present. With `protection: "diverse"` the
legs are the minimum-cost edge-disjoint pair (Suurballe) where the graph allows one; where it does not,
the second leg is the path that shares the fewest metres and `diversity.shared` names every shared
segment with its metres (`diversity.sharedM` is `null` when there is only one leg: there is nothing to
compare). Each leg carries its own `budget` from `budget.pointToPoint`, so reach, loss
budget and overload are three verdicts per leg. `direction` picks which half of the circuit
`budget` and `verdict` describe (default `"down"`, A launching into B); any value other than
`"up"`/`"down"` is a 400, because the two directions are different receivers at different
wavelengths and refusing beats reading a typo as `"down"`.
**A circuit is two links over that one path**, so each leg also carries `upstream` - a second
`pointToPoint` call with `direction: "up"`, always the B → A direction whatever `direction` asked for,
and the same object as `budget` when the caller asked for `"up"` - with its own `upstreamVerdict`;
the top-level `upstreamVerdict` is the worst of the legs, and it is `null` on a refusal, which routed
nothing and so measured neither direction. The half not asked for is **warned about, not gated**:
a failing `upstream` adds `A-leg: fails upstream over the same path - <reasons>`, naming the one pad
to buy when both directions ask for one, but `verdict` and `ok` stay the direction the caller asked
for - the same treatment auto-design gives `upstreamVerdict` / `metrics.upstreamFailOnts`, and
whether an upstream failure should refuse a circuit is open in #185/#111. A mixed pair is not
symmetric: `sfp-1g-lx-10km` at A and `sfp-1g-ex-40km` at B over a 3.0 km duct read `ok` downstream at
-12.65 dBm and `fail` upstream at -2.65 dBm, because the EX launches its floor into the LX receiver's
-3 dBm overload point: a 5 dB pad, not more reach.
`legs[].routedM` is the graph measurement,
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
carries the allowance (`odnLossDb` 11.86 + 2 for `{"allowanceDb":2}`). Measured on a project of one 1:8
splitter and 3 km of `g652d-loose-12`: `{}` answers `totalLossDb` 11.86 with `headroomDb` 18.14,
`{"allowanceDb":2}` answers 13.86 and 16.14, `{"spliceModel":"mechanical"}` adds 0.2 dB at the splitter's
splice, and `{"connectorModel":"lc-apc"}` takes 0.05 dB off each of the two connectors.
`txDbm` is the same launch the design budget reads, and it moves the verdict because the overload point is judged at it:
the same project's `{}` is -8.86 dBm at +3 dBm, inside the ONT's -8 dBm overload point, while
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
real field (`margin` for `marginDb`) or one letter wrong, and names the field that was meant. Every
other key is still ignored — `name`, `notes` or a caller's own bookkeeping passes through untouched,
because a guard that refused every unknown key would refuse a caller who is not wrong.
`budget.pointToPoint`, the **active** budget, refuses the same way against its own list (`headEnd`,
`cpe`, `spans`, `splices`, `spliceModel`, `connectors`, `connectorModel`, `thirdParty`, `allowanceDb`,
`marginDb`, `wavelength`, `direction`, `txDbm`); no endpoint hands a caller's body to it, since
`/api/design/link` builds that design from its own named options, so over the HTTP surface the refusal
is the PON budget's.

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
engine's TIA-598 address and colour, and how it is terminated — the strand it is spliced to at a
closure, `parked` when it arrives on one cable and leaves on none, or `splitter input` / `splitter
port P<n>` at a splitter, whose rows are never spliced across the split. The browser's own **Print → Save as PDF** is the PDF path; nothing is
rendered into a PDF on the server and no library is loaded.

The **Checks** section opens its budget warnings with one plant-level sentence about the OLT's launch
window, built by `budget.launchWindowNote` — the same sentence a synthesised design puts in its
`warnings`, so the page a crew signs off and the report that chose the design cannot disagree about it.
It states the share of the estate in the band and the pad to buy, once, and the per-ONT warnings stay
underneath it because a warning names the ONT it is about. Measured on a C+ OLT with a 1:8 cassette
200 m away and two ONTs on 30 m drops (ODN 11.25 dB, so `ok` on both verdicts), the line reads:

```
2 of 2 ONTs are inside the overload point only at the bottom of the OLT gpon-c-plus-8 launch window:
worst 3.75 dB over at the 7 dBm top, so 4 dB of inline pad at the OLT carries the design to full
launch - as it stands it holds only while every line card lands at 3 dBm
```

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
