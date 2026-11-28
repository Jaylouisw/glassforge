# Auto-design: a list of addresses in, a topology out

The question this answers: *"here are forty houses and a PoP — what should I build, and what does it
cost in cable?"*

```
POST /api/design/synthesise
{
  "demand": "label,lat,lon\nCasa 1,51.5000,-0.1000\nCasa 2,51.5005,-0.0998",
  "headEnd": { "lat": 51.4985, "lon": -0.1004, "name": "PoP" },
  "technology": "auto"
}
```

The same demand becomes one candidate per shape and setting, each one is validated and budgeted, and
the best-ranked feasible one wins — fibre-metres by default, money when a `costs` model is supplied.
With the defaults that is **nine** candidates: three PON ratios (`pon.ratios`: 1:8, 1:16, 1:32) and
both active shapes for each of three optic pairs (`active.optics`, three `{ headEndOptic, cpeOptic }`
pairs of model slugs: `sfp-1g-lx-10km`, `sfp-plus-10g-lr-10km`, `sfp-plus-10g-er-40km` — both 10G pairs
are the SFP+ `plus-` models, which the report labels `PLUS-10G-LR-10KM` and `PLUS-10G-ER-40KM`).
`technology: "pon"` or `"active"` drops the other family, and the count follows the ratios and optics you
pass. An `active.optics` entry is a **pair object**, not a bare slug: `{"optics":["sfp-1g-lx-10km"]}` is a
`400` whose reason is `the design reads "active.optics" as { headEndOptic, cpeOptic } pairs and got
"sfp-1g-lx-10km" at position 0. Each entry is one optic at each end of the link.` An entry that names
only one end is refused by name unless the block names that end once (`active.cpeOptic`, see
[API.md](API.md#auto-design)). The values are model slugs, not the labels the report prints:
`{"headEndOptic":"10G-LR-10KM","cpeOptic":"10G-LR-10KM"}` builds both active candidates, and each is
refused with `node "n-headend" uses unknown transceiver model "10G-LR-10KM"`.

| Candidate | Shape | What one customer costs |
|---|---|---|
| `pon`, one per ratio in `pon.ratios` | feeder tree → splitter sites → distribution tree | one fibre per ONT, one splitter port |
| `active-tree`, one per optic pair in `active.optics` | one cable tree with closures, tapered | a dedicated fibre pair per ONT |
| `active-home-run`, one per optic pair | one cable per customer | a dedicated fibre pair, and a drum per house |

Each candidate is reported whether it wins or not, with its numbers and the reason it was refused.

`demand` in the answer is that parse, not the points: `{ points, rejected, duplicates, meta, bbox }`,
with each refused row's 1-based input line, reason and text — so the rows a design was built from sit
beside the design rather than in a second call — and `headEnd` is the site it was given. The shape and
the refusal are in [API.md](API.md#auto-design).

## In the UI

The same request is the **Auto-design** panel in `web/`: paste the list into the demand box, type the
head-end's latitude and longitude, optionally import a street network (KML/KMZ) for the panel to send
as `network`, and press **Design**. The result opens on the Auto tab with the winner's label, the
`rationale` lines, the winning design's budget warnings and the candidate table. The panel's
technology select is the endpoint's `technology`: `auto`, `pon` or `active`.

**Apply to this project** re-sends the request with `applyToProject`, so the plant replaces the open
project's plant in one undo step. With no project open the button does nothing, because there is
nothing to apply it to.

## The pipeline

```
demand (CSV / JSON / KML points)
  → demand.prepare        parse, reject bad rows, dedupe, assign ids
  → geometry              straight-line distance × routeFactor (default 1.2)
  → topology builder      PON: cluster → feeder tree → distribution tree
                          active: minimum spanning tree over the demand
  → network.validate      a tree with one head-end, real models, measured spans
  → network.allOntBudgets one budget per ONT, against the right technology
  → bomOf                 cable per model, drums, fibre-metres
  → ranking               cost, or fibre-metres, then splices, closures, optic speed
```

## Why fibre-metres, not metres

Cable is priced roughly with its fibre count: a 24-fibre trunk is not the same purchase as a 12-fibre
distribution run of the same length. Ranking by plain metres makes a fat tree look cheaper than it is
and picks the wrong topology on any street longer than a few hundred metres. The default objective is
therefore

```
fibre-metres = Σ span length × bundles × cable.fiberCount
```

and `cableM` stays in the output as its own metric. Supply `costs` (`cablePerM` per model, plus
`splice`, `closure`, `splitter`) and the objective switches to money — and the response says which
objective it used.

A money price is a purchase order, so cable is priced on the **drums the design buys**: `cablePerM ×
purchaseM`, the design length rounded up to the cable's own drum once per model (SPEC §5), never
`cablePerM × designM`. Pricing the design length quoted three drums of 12-fibre as the 850 m actually
hung and let the ranking disagree with the BOM it had just built — a spare drum costs money and the
objective has to see it. `metrics.designM` and `metrics.drums` stay as the length and the drum count,
and `metrics.costBreakdown: { cable, splices, closures, splitters, total }` reports the terms, so the
ranked number can be checked by hand.

`costs` is read as a **complete** price list, so a term it leaves unsaid is refused by name rather
than charged as zero. `synthesise` collects the cable models every candidate builds with and whichever
of `splice`, `closure` and `splitter` it actually builds, and answers a `400` naming what is missing:
a 12-house estate whose cable prices are complete but which leaves the labour terms out is refused
with `costs.closure, costs.splice and costs.splitter are not priced, and a design here builds them - a
money objective that charges an unsaid term as 0 quotes a total short of what the design costs, so
price the term or write 0 to say it costs nothing; omit costs to rank by fibre-metres`, and an
unlisted cable is `costs.cablePerM has no price for g657a2-drop-1, g657a2-drop-2 …`. Writing `0` is how
a caller says a term is free — it is a figure the ranking can use — and a term no candidate builds
needs no price at all: `technology: "active"` with no `splitter` entry answers `200`, while the same
costs at `technology: "pon"` is the `costs.splitter is not priced` refusal. A total that is short a
term is a total nobody can spend.

## How each topology is built

### PON

1. **Cluster** the demand with deterministic k-means, k = ⌈n / ratio⌉. Centres are medoids (a real
   address, so a box can be placed); the cluster count rises until every cluster is within the
   splitter ratio **and** within `pon.maxDropM`.
2. **Feeder**: a minimum spanning tree from the head-end through a closure at every splitter site.
   Each splitter hangs off its closure on a 1 m tail. That tail is not decoration: without it the
   feeder would pass *through* splitter nodes and a path to the third site would be charged three
   splitter losses, inventing a 1:512 cascade that no ONT is behind.
3. **Distribution**: a tree from the splitter past the houses, **one fibre per ONT**, tapered to the
   smallest cable that carries the subtree. A house the cable passes becomes a closure with a drop
   span — the measured snap distance when the run is street-routed, and 1 m when it is not, because a
   straight-line spur is 0 and `Math.max(1, round(spurM, 1))` keeps the span measured; a house at the
   end of the run is the ONT itself.
4. Cable floor: 12 fibres for a feeder, because nobody pulls a 4-fibre feeder.

### Active Ethernet

A minimum spanning tree from the head-end over every address, then:

- each branch point becomes a closure chosen by the **cables** that reach it, not by its tree
  degree: the smallest NAP whose `ports` take every cable into the node (each cable of a bundle
  enters the box, and every drop is one cable), otherwise the largest NAP in the catalogue. The
  20-spoke junction of `test/design-closure-ports.test.js` plus its spine is 21 cables and buys
  `nap-24` (26 ports); the feeder closure of an ordinary 1:8 PON site is still `nap-8` (9 ports).
  An in-line mufa is a through-joint with four cable ports and is never chosen for a branch point.
  `closureForCables` in `engine/design.js` is the one chooser, and
  `test/design-closure-ports.test.js` asserts both ends of the ladder.
- each span carries **two fibres per ONT below it**, tapered to the smallest cable that fits;
- a house the tree passes becomes a closure plus a drop span, measured the same way as a PON drop
  (the snap distance when routed, 1 m straight-line);
- every optic pair in `active.optics` is tried, because the cheapest optic that closes the budget is
  a different answer at 2 km and at 30 km.

`active-home-run` is built too, as the honest upper bound: one cable per customer, no shared plant.

## Determinism

No `Math.random`. K-means seeds from the point nearest the head-end then farthest-first; the MST is
Kruskal sorted by length and then by node id; the ranking has a total order. The same demand and
options produce byte-identical JSON, which is what makes the tests worth having and a re-run
comparable.

## Routing: street graph or straight line

Two providers, chosen by whether `network` is supplied. Both produce the same tree shape, so the
builders, the cable taper and the ranking are shared.

### street-graph

```
KML / KMZ / { edges }  →  graph (vertices merged within 1.5 m; T-junctions and crossings split)
                       →  snap every property onto the nearest edge, splitting it
                       →  Dijkstra from the root
                       →  union of shortest paths to every terminal, pruned
                       →  contract degree-2 junctions, keep the polyline
```

- **A crossing between two lines is a junction.** A T-junction has a vertex that lands on a line; a
  crossing has none on either line, so merging vertices alone leaves the graph in two components and a
  whole road comes back "not on the street network" when the geometry is sound — which is every pair of
  roads exported as separate polylines. `street.planarize` therefore runs two passes: vertices that
  land on an edge's interior, then a sweep for transversal crossings (as seen from both lines, each
  line's ends on opposite sides, and at least 0.05 m clear of the other line — a graze is not a
  junction), whose points become nodes the first pass then cuts. The sweep is pruned by longitude and
  by per-edge bounding boxes, so a grid-shaped import costs work per node, not per node × edge.
  **The assumption is stated because it is one:** two streets at grade do meet, but a duct passing
  *under* a street on another level would be joined too. The geometry carries no level and the graph
  does not invent one, so a grade-separated crossing must be offset in the import or given its node.
- **A property is snapped to the nearest edge, and the gap is a real length.** A house is not on the
  centreline: the distance from the property to the point it joins the street is the drop, carried as
  `spurM` and emitted as a drop span. It is not rounded away and it is not a 2 m placeholder.
- **The tree is the union of shortest paths, not the sum of pairwise routes.** Walking 40 shortest
  paths and adding them up counts the shared trunk once per house; the union counts it once. It is not
  the optimal Steiner tree — that is a much larger piece of work — but it is deterministic, it is the
  tree a planner actually draws, and its length is the true sum of street edges.
- **Degree-2 junctions with nothing attached are contracted.** A street polyline with forty vertices is
  one cable run, not forty spans: the geometry survives as `route` on the span, the length as one
  number.
- **A property the graph cannot reach is refused by name.** More than `maxSnapM` (default 250 m) from
  the nearest edge, or disconnected from the head-end, and the candidate is infeasible with
  `"2 address(es) are not on the street network or not reachable along it: d7, d19"`. Connecting it
  with a straight line would be the one number in the design nobody could defend.
- **The head-end must be on the network too.** A PoP 2 km from the nearest street is a data problem,
  and it is reported as one rather than snapped from afar. Its own gap to the street is cable like
  anybody's: every edge leaving the head end carries the measured `spurM` and its route starts at the
  head-end coordinate, because the head end is the one site with no drop span to carry the gap. A
  splitter site is not charged the same way - it is a house in the demand list, and its drop already
  pays for its gap.

### straight-line

`distance × routeFactor` (default 1.2) between every pair, minimum spanning tree. This is what you get
with no network imported, and it is honest about being an estimate: `routeMethod` says
`straight-line x1.2` and every run carries no `route` beyond its two ends.

### What the response tells you

```
routeMethod: "street-graph (30 edges, 0.361 km)"
runs: [{ id: "s-feed-1", purpose: "feeder", lengthM: 158.18, method: "street-graph (...)", route: [15 points] }]
```

`runs[].method` is repeated per run so a stored design can be audited later, and `runs[].route` is the
street geometry — the canvas draws it, so the drawing and the BOM describe the same cable.

A worked comparison on a 10-house cul-de-sac off a main road: 507 m straight-line (×1.2) against
577 m routed along the streets, with two feeder spans carrying 15 and 6 points of geometry. The
difference is almost exactly the detour to the junction, which is the whole point.

## What it does not do

- **No map download.** The graph is whatever was imported; the server makes no outbound requests, so
  there is no built-in OSM fetch.
- **No geocoding.** An address without coordinates is refused rather than looked up. A CSV needs
  `lat`/`lon` columns.
- **No active-equipment sizing.** An active design counts fibres and optics, not switch ports, uplinks
  or chassis. `capacity()` says so: an active plant reports `ports: null` rather than inventing a
  ceiling.
- **Splice counts are estimates.** One splice per closure on the path, one per splitter tail. A real
  closure splices every fibre it passes, so a 24-fibre through-joint is 24 splices in the field and 1
  in this budget. The loss figure is a design allowance, not a splice plan.

## Reading a result

```jsonc
{
  "ok": true,
  "objective": "fibre-metres",
  "routeMethod": "straight-line x1.2",
  "technology": "pon",
  "best": { "label": "PON 1:8 with 3 splitter site(s)", "metrics": { "cableM": 2987.7, "fibreMetres": 26987.7,
            "onts": 24, "splitters": 3, "closures": 21, "worstHeadroomDb": 20.7, "marginalOnts": 0,
            "launchWindowOnts": 0 } },
  "candidates": [ { "label": "...", "feasible": false, "reasons": ["..."], "metrics": {...} } ],
  "plant": { "nodes": [...], "spans": [...] },   // the winner, ready for network.validate
  "runs": [ { "id": "f-root-site-1", "from": "n-headend", "to": "fc-site-1", "purpose": "feeder",
              "cable": "g652d-loose-12", "lengthM": 421.3, "bundles": 1, "strands": 12,
              "feedsOnts": null, "method": "straight-line x1.2",
              "route": [ { "lat": 51.4985, "lon": -0.1004 }, { "lat": 51.5008, "lon": -0.1 } ] } ],
  "rationale": [ "Chosen: ...", "Rejected ...: feasible but needs ... (1.04x)" ]
}
```

`runs[]` is the flattened span list a drawing or a stored design reads: `lengthM`, `bundles`,
`strands` (a count, not the indices), `purpose`, `feedsOnts` (the ONT count recorded against a
distribution, tree, home-run or drop span; `null` on a feeder or splitter tail), `method` and `route`.
A feeder span's splitter count is **`feedsSplitters` on the winner's `plant.spans`**, not on `runs`:
`runsOf` does not copy it.

`metrics.marginalOnts` counts the ONTs whose verdict is `marginal` — a design that passes, but with under
2 dB above the design margin or under 1 dB of its class budget left (SPEC §4) — and `warnings` names the
tightest one once for the whole plant. Each candidate's `budgets` carries one row per ONT,
`{ ont, name, verdict, marginalReason, headroomDb, rxPowerDbm, launchWindowPad, upstreamVerdict,
upstreamRxPowerDbm, error }`, so a marginal verdict can be read per address instead of only as a
plant-level sentence. `verdict` is the downstream half; the upstream columns are the other link over the
same ODN (see below).

`metrics.launchWindowOnts` counts the ONTs that are inside the receiver's overload point only at the
bottom of the OLT's launch window — the band [OPTICAL.md](OPTICAL.md#the-band-between-the-two-launches)
describes — and the winner's `warnings` carries that band as one sentence: the count, the worst
overshoot at the top of the window and the pad to buy. It comes from `budget.launchWindowNote`, the
same function the printed plan calls, so the report and the page a crew signs off say the same thing.
The band does not make a design infeasible — the candidate stays `ok` and `feasible`, and whether that
is right is still open in issue #5 (the launch-window verdict) — and `launchWindowPad` on each budget
row is the per-ONT figure behind the plant-level count.

`metrics.upstreamFailOnts` counts the ONTs that fail the **other** half of the same link — the ONT
launching into the OLT at 1310 nm, the lossier wavelength, budgeted with `direction: 'up'` and the OLT's
receiver ([OPTICAL.md](OPTICAL.md#the-formula)). A PON is two links over one ODN, and ranking on one of
them offered a 12-house C+ estate whose every ONT was `ok` downstream and `fail` upstream as the best
feasible design with nothing said (#6). Each row's `upstreamVerdict` and `upstreamRxPowerDbm` carry that
pass per address, and it is `null` when the upstream pass could not budget the row at all; the row's
`error` then carries the downstream pass's own failure. The winner's `warnings` carries one plant-level
sentence from `budget.upstreamNote`: how many ONTs fail, the worst one, its reason, the pad that clears it
and how many more fail behind it.

That sentence is **reported, not gated**: `feasible` and the ranking still rest on the downstream
verdict, because only a ceiling on ODN loss is modelled and no class floor, so gating on it would
empty auto-design for an ordinary short-feed estate. Whether an upstream failure should refuse a
candidate is the open decision in #6 (the upstream verdict) / #5 (the launch-window verdict), and
the design report does not make it in passing. One pad is ODN loss in both directions, so the
sentence sizes the pad for the louder receiver and says so when the launch-band pad would leave the
other end over its limit.

`rationale` is written to be checkable: every line quotes the numbers the comparison used. When
`ok` is false there is no `plant`, and every candidate carries the reasons it was refused — a design
tool that says "no" without saying why is a tool nobody trusts twice.

## Applying a design

`applyToProject` replaces the project's plant in one operation, so one undo takes it back:

```
POST /api/design/synthesise { "demand": "...", "headEnd": {...}, "applyToProject": "p1a2b3" }
→ { ...result, "applied": { "projectId": "p1a2b3", "nodes": 49, "spans": 48, "warnings": [] } }
```

The plant is re-checked after the swap; a design that does not validate is refused and the project is
left alone.

## Site-to-site links (DC to DC)

`POST /api/design/link` (engine: `link.design`) answers the other question: **two named sites, an
optic at each end, no splitter and no ONT**. The result is a circuit, not a plant — two paths between
the same pair of nodes is a cycle, and `network.validate` is right to warn about a cycle in a tree, so a
link is never squeezed into the plant model.

```
POST /api/design/link
{
  "sites": { "a": { "name": "DC-West", "lat": 51.5000, "lon": -0.1020 },
             "b": { "name": "DC-East", "lat": 51.5000, "lon": -0.0960 } },
  "network": { "edges": [ ... imported duct or street geometry ... ] },
  "optics": { "a": "sfp-plus-10g-er-40km", "b": "sfp-plus-10g-er-40km" },
  "protection": "diverse",
  "thirdParty": [ { "provider": "CityFibre", "lengthM": 300, "lossDb": 0.6, "cost": 1200, "leg": "b" } ]
}
```

### Both legs are routed along the graph, never a chord

`street.diversePaths` measures every leg on the supplied graph. There is no straight-line fallback while
a graph is present: a chord for a duct route is the one number in the result nobody could defend, which
is why `routedM` is the sum of street edges and `route` is the street geometry. The one case it is not
called for is a coincident pair — both sites on the same node — which has a single leg of `routedM: 0`
(SPEC §9).

A worked grid — two sites 415.3 m apart on the same latitude, with no street between them, and a north
and a south street joining them at either end:

| | measured on the graph |
|---|---|
| straight line A→B (not used) | 415.3 m |
| A-leg, south street | **526.5 m** (415.3 + 2 × 55.6) |
| B-leg, north street | **637.7 m** (415.3 + 2 × 111.2) |
| shared duct | **0 m** |

The legs are longer than the chord precisely because they went round the junction, and the corner
points are in `route`, so the drawing and the BOM describe the same cable.

`routeMethod` is `street-graph (N edges, X km)`, and every `runs[]` entry repeats it with its own
`route`. Without a network the method is `straight-line x1.2`, there is one leg, and the result says
that no protected pair can be drawn — it does not pretend otherwise.

### Diversity is measured and printed

The pair is the minimum-cost edge-disjoint pair the graph allows (Suurballe: shortest path, reverse its
arcs at negative cost, shortest path in the residual graph, cancel the arcs used in opposite
directions). A ring gives two legs of half the ring each and `sharedM: 0`, and `sharedNodes: []`.

Edge-disjoint is not the same claim as diverse. Two legs can share no duct at all and still pass
through one chamber — two ducts on either side of one manhole, or a side street drawn from the middle
of the main road, which `planarize` turns into a junction — and a fire or one excavation there takes
out both. `diversity.sharedNodes` names those interior vertices as `{ nodeId, lat, lon }` (sorted by
id; `sharedNodeCount` repeats the length) and the two sites are excluded, because both legs start and
end at them. A pair with a shared joint is not `achieved` however clean the metres read, and the
sentence says so: `no duct is shared, but both legs pass through 1 shared joint node
(51.500000,-0.099000): one failure in that chamber takes out both legs`. It is reported, never routed
around: the pair stays the minimum-cost edge-disjoint pair, which is the documented method.

Where the graph offers no second route — one corridor into the building, the normal case — the second
leg is the path that **shares the fewest metres**, and the sharing is reported rather than hidden:

```jsonc
"diversity": {
  "achieved": false,
  "sharedM": 415.32,
  "shared": [ { "kind": "duct", "edgeId": "e1", "lengthM": 415.32, "from": {...}, "to": {...} } ],
  "leasedSharedM": 0,
  "sentence": "diverse except 415.32 m across 1 shared segment(s): 415.32 m of duct 51.500000,-0.102000 -> 51.500000,-0.096000 (e1)"
}
```

A protected request whose legs share anything carries a warning quoting the same metres. Site drops
(the snap distance from each building to the duct) are counted as shared, because both legs enter the
same building the same way; a leased segment on `leg: "both"` is counted separately in
`leasedSharedM`.

A circuit that built **one leg** says which cause it was, in `diversity.sentence`, and the cause is the
thing that actually decided it rather than the loudest-looking one. `protection: "single"` is a request,
not a finding about the duct: `one leg: protection is "single", so the shortest route is built and the
circuit is unprotected` - the grid in `test/link-design.test.js` gives two edge-disjoint legs under the
`diverse` default, and until gh#118 the same network reported "the graph offers a single route between
the sites" when asked for `single`. The other three causes are named as what they are: both sites
snapping to one node (no duct run between them, nothing to protect), a graph the router could only
draw one route on, and no graph at all (`one straight-line leg: ...`). `protection.legs` is 1 in every one of those cases, so it
is a count and never a verdict about the network; `diversity.sharedM` is `null` because there is nothing
to compare.

### Both directions per leg, and leased fibre that is not cable

Each leg is its own `budget.pointToPoint` call in the direction the caller asked for (`direction`,
default `"down"`, A launching into B), so reach, loss budget and overload are three separate verdicts
**per leg**. A circuit is two links over that one path, so each leg also carries `upstream` - the same
call read the other way (`direction: "up"`, always the B → A direction whatever was asked for, and the
same object as `budget` when `"up"` was asked for) - with its own `upstreamVerdict`; the top-level
`upstreamVerdict` is the worst of the legs and `null` on a refusal, which routed nothing. Reasons are
prefixed with the leg they belong to (`A-leg: the route is 50038 m but the shorter optic reaches 40000 m`).

The directions are **not symmetric** whenever the ends are different optics, and an asymmetric
circuit gets two answers, not an average: `sfp-1g-lx-10km` at A and `sfp-1g-ex-40km` at B over the
3.0 km duct read `ok` downstream at -12.65 dBm and `fail` upstream at -2.65 dBm, because the EX
launches its -1 dBm floor into the LX receiver's -3 dBm overload point. That is a 5 dB pad, not more
reach. A failing upstream direction is **reported, not gated**: the leg warns `A-leg: fails upstream
over the same path - <reasons>`, sizes the one pad to buy when both directions name a pad, and
leaves `verdict` and `ok` on the direction the caller asked for - the same treatment the auto-design
rows get above, and whether upstream should refuse a circuit is the open decision in #6 (the
upstream verdict) / #5 (the launch-window verdict).

A leased (third-party) segment carries a provider, a stated length and a stated loss. It is charged to
the budget of the leg it rides, counted in the path length and in the cost, and **excluded from the
cable metres** — nobody buys cable for a duct they rent:

```jsonc
"bom": { "cableM": 1164.22,
         "thirdParty": { "totalM": 300, "lossDb": 0.6, "cost": 1200, "costComplete": true,
                         "segments": [ { "provider": "CityFibre", "lengthM": 300, "attached": true } ],
                         "unattachedM": 0, "unattachedLossDb": 0, "unattachedCost": 0,
                         "inCableBom": false } }
```

`cost` is optional and unitless: the caller states it in whatever unit it buys in, and the report
never invents a price (`costUnit` says so). **Absent or `null` means unpriced** — the lease's stated
metres and loss are still charged to the budget, but `cost` is `null` and `costComplete` is `false`
— while **`0` is a stated price**, so a free lease reads `cost: 0, costComplete: true`. A present
`cost` that is not a non-negative number is refused by name (`thirdParty[0].cost must be a
non-negative number ... got "50"`), never read as unpriced: a form field that sent `"50"` used to
answer `cost: null` with a `costUnit` saying the caller had stated no price, so a stated cost vanished
from the circuit's money, and a negative one was summed into a credit nobody agreed to.

`attached` is the whole question. A segment rides a leg only when that leg was built: `leg: "b"` on a
`protection: "single"` circuit, on a graph that offered one route, or on a request where routing
failed, belongs to a leg that does not exist. Those segments are still listed (`attached: false`),
summed in `unattachedM`, `unattachedLossDb` and `unattachedCost`, and left out of `totalM`, `lossDb`
and `cost` — the light never crosses them, so no budget is charged their loss and nobody buys them. A
circuit that was built with one leg also warns, naming the provider.

Lengths are reported three ways, because they answer three questions: `routedM` (measured on the graph),
`ownM` (routed plus both site drops — the cable you buy) and `lengthM` (everything, leased included —
the path the light takes).

### Refusals

- A site farther than `maxSnapM` (default 250 m) from the graph, or on another component: `ok: false`
  with the site named. It is never snapped from afar.
- A leg that exceeds the optic's reach, or lands above its overload point: `ok: false`, one reason per
  leg, quoting the measured length and the reach (or the receive power and the overload point).
- A leased segment with no `lossDb`: thrown. A leased span whose loss is unknown is not a figure, and
  zero is not a default.

### What it does not do

- No amplifiers or regeneration, no CWDM/DWDM multi-wavelength budgets, no per-segment duct capacity.
- No splice plan for a fat cable, and no per-strand count in the budget: a joint costs the light **one**
  splice whatever the cable carries (`legs[].spliceEvents`), because the strand crosses it once
  (SPEC §3). The crew's count - one per strand per joint, `spliceEvents × splicesPerJoint`
  (`splicesPerJoint` defaults to `fibres`) - is reported as `legs[].splices` and summed in
  `bom.splices`. It is a labour estimate, not a splice plan. Folding the labour count into the budget
  charged a 24-fibre leg 24 × 0.10 dB at a single joint: the same duct route passed on 2 fibres and
  failed on 24 with nothing changed in the glass or the optics.
- No geocoding and no basemap in the panel: the head-end is typed as latitude and longitude, and a
  street network has to be imported rather than fetched.
