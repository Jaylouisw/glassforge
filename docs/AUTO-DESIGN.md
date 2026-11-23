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

Four candidate topologies are built from the same demand, each one is validated and budgeted, and the
cheapest feasible one wins.

| Candidate | Shape | What one customer costs |
|---|---|---|
| `pon` (per splitter ratio) | feeder tree → splitter sites → distribution tree | one fibre per ONT, one splitter port |
| `active-tree` | one cable tree with closures, tapered | a dedicated fibre pair per ONT |
| `active-home-run` | one cable per customer | a dedicated fibre pair, and a drum per house |
| `pon` at another ratio | as above | a shorter splitter cascade, fewer sites |

Each candidate is reported whether it wins or not, with its numbers and the reason it was refused.

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
   smallest cable that carries the subtree. A house the cable passes becomes a closure with a 2 m
   drop; a house at the end of the run is the ONT itself.
4. Cable floor: 12 fibres for a feeder, because nobody pulls a 4-fibre feeder.

### Active Ethernet

A minimum spanning tree from the head-end over every address, then:

- each branch point becomes a closure (NAP up to 8 ways, NAP-16 to 16, in-line mufa beyond that);
- each span carries **two fibres per ONT below it**, tapered to the smallest cable that fits;
- a house the tree passes becomes a closure plus a 2 m drop;
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
KML / KMZ / { edges }  →  graph (vertices merged within 1.5 m)
                       →  snap every property onto the nearest edge, splitting it
                       →  Dijkstra from the root
                       →  union of shortest paths to every terminal, pruned
                       →  contract degree-2 junctions, keep the polyline
```

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
  and it is reported as one rather than snapped from afar.

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
            "onts": 24, "splitters": 3, "closures": 21, "worstHeadroomDb": 20.7 } },
  "candidates": [ { "label": "...", "feasible": false, "reasons": ["..."], "metrics": {...} } ],
  "plant": { "nodes": [...], "spans": [...] },   // the winner, ready for network.validate
  "runs": [ { "id": "s-feed-1", "purpose": "feeder", "cable": "g652d-loose-12", "lengthM": 421.3, "feedsSplitters": 3 } ],
  "rationale": [ "Chosen: ...", "Rejected ...: feasible but needs ... (1.04x)" ]
}
```

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
is why `routedM` is the sum of street edges and `route` is the street geometry.

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
directions). A ring gives two legs of half the ring each and `sharedM: 0`.

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

### One budget per leg, and leased fibre that is not cable

Each leg is its own `budget.pointToPoint` call, so reach, loss budget and overload are three separate
verdicts **per leg**: an asymmetric circuit gets two answers, not an average. Reasons are prefixed with
the leg they belong to (`A-leg: the route is 50038 m but the shorter optic reaches 40000 m`).

A leased (third-party) segment carries a provider, a stated length and a stated loss. It is charged to
the budget it belongs to, counted in the path length and in the cost, and **excluded from the cable
metres** — nobody buys cable for a duct they rent:

```jsonc
"bom": { "cableM": 1164.22, "thirdParty": { "totalM": 300, "cost": 1200, "inCableBom": false } }
```

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
- No per-joint splice count for a fat cable: a joint splices the circuit's fibres (`fibres`, default 2),
  and that is the budget's splice allowance, not a splice plan.
- No UI yet: the endpoint and the engine are the contract this landed with.
