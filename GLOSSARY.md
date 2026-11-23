# Glossary

The vocabulary Glassforge uses. Terms are defined as the code defines them; where the code and this file
disagree, the code is the truth and this file is a bug.

## Networks and plant

**ODN** — optical distribution network. Everything between the active equipment at the head end and the
customer's ONT: cable, closures, splices, connectors, splitters.

**Plant** — the tree the engine designs: nodes joined by spans, each node a type (`olt`, `headend`,
`splitter`, `closure`, `ont`).

**Span** — one cable run between two nodes, with a `lengthM` and a `purpose` (`feeder`, `distribution`,
`drop`, `splitter-tail`, `tree`, `home-run`, or `link` for a leg of a site-to-site circuit).

**Head end** — where the provider's signal starts. `olt` for a PON, `headend` for an active
point-to-point or active-over-tree design. The root node type selects the budget that is applied.

**Splitter site** — a closure that holds a splitter, reached by a 1 m **splitter tail** so a feeder
cable passing three sites is not mistaken for three cascaded splitters.

**Cascade** — the deepest split ratio from the root to any leaf: the product of the `ratio` of every
splitter on the deepest root-to-leaf path, not the product of every splitter in the plant. It is exposed
as `splitterCascade` on the capacity object (`capacity()` in `engine/network.js`, compared against the
OLT's `maxSplitRatio`); `maxCascade` is the local variable that computes it, not a field.

## Money and cable

**Fibre-metres** — length × fibre count. The design objective: cable is priced roughly with fibre count,
so 24 fibres × 1 km is not the same purchase as 24 runs of 1 fibre × 1 km.

**Cable-to-buy** — every span resolved onto a purchasable cable part, with the drum lengths and the
total metres.

**Drop cable** — the small 1–2 fibre cable used on the last leg, only at or below `DROP_CABLE_MAX_M`
(300 m). Anything longer goes to the 12-fibre ladder whatever the fibre count.

**Part** — a catalogue entry under `parts/<kind>/<model>.json`, carrying its figures, a `sourceUrl` and
`notes` saying where each figure came from.

## Routing

**Street graph** — the imported geometry (KML, KMZ or a plain edge list) that fibres are routed along.

**Snap** — projecting a property or a site onto the nearest point of the nearest street edge, splitting
that edge at the projection so the connection is real.

**Join tolerance** — the distance within which a vertex is treated as the same junction, so a side street
drawn from the middle of a main road is connected rather than a second component.

**routeMethod** — how a run's length was measured: `street-graph` when it walked the geometry,
`straight-line xN` when no network was supplied. A street-routed design never reports a straight line
without saying so.

**Route factor** — the multiplier applied to straight-line distance when there is no geometry to walk.

**Diversity** — for a two-site link, how much of the second leg shares geometry with the first, reported
in metres and naming every shared segment. A third-party segment is a leased circuit: it carries a stated
length and loss, and stays out of the cable-to-buy.

## Circuits and legs

**Circuit** — a site-to-site link: two named sites, an optic at each end, and one or two legs
(`link.design` in `engine/link.js`). Deliberately not a plant, because two paths between the same pair of
nodes is a cycle and a plant is a tree.

**Leg** — one fibre path between the two sites of a circuit: `a` (the A-leg) or `b` (the B-leg), each
routed on the graph and budgeted on its own with `budget.pointToPoint`, so each carries its own
`verdict`. Listed in `legs[]` and repeated, flattened, in `runs[]` with `purpose: "link"`.

**Protection** — `"diverse"` (the default) or `"single"`: whether a second leg is asked for. `diverse`
never invents diversity — where the graph offers no edge-disjoint pair, the second leg is the one that
shares the fewest metres and `diversity.shared` names each shared segment with its metres. Anything else
is refused: `protection must be "diverse" or "single"`.

**routedM / ownM / lengthM** — the three lengths a leg reports, because they answer three questions:
`routedM` is what the graph measured, `ownM` adds both site spurs (the cable to buy), and `lengthM` adds
the leased segments. `spurM` and `leasedM` sit beside them, so `lengthM = ownM + leasedM`.

## Design and refusal

**Demand** — the address list a design is synthesised from (CSV or JSON, header by name, latitude and
longitude required).

**Synthesis** — choosing a topology (PON, active over tree, active home run) and producing the plant,
the budgets and the bill of materials for a demand.

**Refusal** — an explicit rejection that names the address or the row responsible. The alternative — a
straight line drawn to a property that has no route — is never acceptable.
