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

## What it does not do

- **No street or duct routing.** Every length is straight-line × `routeFactor`, and every response
  says so in `routeMethod`. Routing along imported geometry is its own piece of work; a synthesised
  street network would make the numbers look more authoritative than they are.
- **No geocoding.** The server makes no outbound requests, so an address without coordinates is
  refused rather than looked up. A CSV needs `lat`/`lon` columns.
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
