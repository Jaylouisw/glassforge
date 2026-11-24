# Glossary

The vocabulary Glassforge uses. Terms are defined as the code defines them; where the code and this file
disagree, the code is the truth and this file is a bug.

## Networks and plant

**ODN** — optical distribution network. Everything between the active equipment at the head end and the
customer's ONT: cable, closures, splices, connectors, splitters.

**Plant** — the tree the engine designs: nodes joined by spans, each node a type (`olt`, `headend`,
`splitter`, `closure`, `ont`).

**Span** — one cable run between two nodes, with a `lengthM` and a `purpose`: `feeder`, `distribution`,
`drop`, `splitter-tail` (a 1 m tail into a splitter site), `tree` (an auto-design tree edge),
`home-run` (one active cable per customer) or `link` (a leg of a site-to-site circuit, from
`engine/link.js`).

**Bundles** — how many cables run one span. A span is one route, not always one cable: when the
fibres it carries do not fit the largest cable in the ladder, auto-design sets `bundles` to the number
of cables needed (160 fibres over a 144-fibre ladder is two), and the cable purchase and the strand
ledger count every one of them. Absent means one; `0` and fractions are a contradiction, refused by
the validator and by the BOM by span and by field.

**Head end** — where the provider's signal starts. `olt` for a PON, `headend` for an active
point-to-point or active-over-tree design. The root node type selects the budget that is applied.

**Splitter site** — a closure that holds a splitter, reached by a 1 m **splitter tail** so a feeder
cable passing three sites is not mistaken for three cascaded splitters.

**Splitter ports** — a cassette's output count is its ratio: a 1:8 PLC has eight. Counted **per
site**, by the branches that leave that splitter toward the customers, so a downstream splitter costs
its parent one port however many ONTs sit behind it — the cascade rule one level down. More branches
than ports is a contradiction (an error, not a warning): a ninth drop on a 1:8 is a fibre with nowhere
to go. `capacity().splitterPorts` reports each site as `{ node, name, model, ratio, portsUsed,
overbooked }`, and the overbooked ones also appear in `problems`, which `validate` turns into errors.

**Cascade** — the end-to-end split ratio of the deepest root-to-leaf path: the ratios of the
splitters on that one path multiplied together, so two 1:8 splitters in line read as
`splitterCascade: 64`. It is not the product of every splitter in the plant — six 1:8 splitters on six
separate branches are six 1:8 paths, not 1:262144 — and it is not a count of splitters. On a plant's
`capacity()` result the exposed field is **`splitterCascade`**; `maxCascade` is the local
variable inside `engine/network.js` that computes it and is not part of any returned object. Report
`splitterCascade`, read `maxCascade` only if you are editing that file.

## Money and cable

**Fibre-metres** — length × fibre count. The design objective: cable is priced roughly with fibre count,
so 24 fibres × 1 km is not the same purchase as 24 runs of 1 fibre × 1 km.

**Cable-to-buy** — every span resolved onto a purchasable cable part, with the drum lengths and the
total metres.

**Cost** — the money objective auto-design ranks by when the caller supplies a `costs` model. Cable is
priced on the **purchased** metres (`purchaseM`: the drums the BOM buys, rounded once per model), not on
`designM`, because the metres nobody sells are metres somebody pays for; `splice`, `closure` and
`splitter` are per-unit prices. `metrics.costBreakdown` reports the four terms and their sum, so a
ranked-by-money verdict is reviewable like a budget.

**Splice schedule** — the sheet a crew works from: every strand arriving on each cable, its TIA-598
address and colour, and how it is terminated (`via`): `splice` at a closure, naming the strand on the
other side (`splicedTo`); `parked` when it arrives and leaves on no cable; `splitter-input` and
`splitter-port` (with a 1-based `port`) at a splitter, where nothing is joined across the split —
the feeder fibre terminates on the splitter and the fibres below it leave from numbered ports. Built
from the same `span.strands` the strand ledger counts.

**Splice event** — one splice on the path the light takes, which is what a budget charges: a strand
crosses a joint once, however many strands the cable carries (SPEC §3 says a closure node is one
splice). The crew's count at the same joint is one splice per strand — `splicesPerJoint`, default
`fibres` — and a link reports the two separately as `legs[].spliceEvents` (the event) and
`legs[].splices` (the crew's count, which `bom.splices` sums). Charging the crew's count as loss put
24 splices on one joint of a 24-fibre leg.

**Strand address** — a strand named the way the tray is: `T03-F07` is tube 3, fibre 7 (`fiber.addressFor`,
`fiber.parseAddress`). The tube size is the **cable's** `fibersPerTube` (1..24, validated), so the same
strand index has a different address in a 24-per-tube ribbon than in a 12-per-tube loose tube, and
`network.spliceTable` derives each row's address from the span's own cable. A span naming an unknown
cable model is addressed at the standard twelve rather than dropped from the sheet.

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

## Links and circuits

**Circuit** — a site-to-site link (`link.design`, `POST /api/design/link`): two sites, an optic at each
end, no splitter and no ONT. Deliberately not a plant: two paths between the same pair of nodes is a
cycle, and a plant is a tree. The response says `mode: "link"`.

**Leg** — one of the circuit's two routes between the sites, `legs[].id` `"a"` or `"b"` (labelled
`A-leg` / `B-leg`). Each leg is budgeted on its own with `budget.pointToPoint`, so a circuit whose legs
are asymmetric gets two verdicts, never an average. A leased segment is assigned to a leg with
`leg: "a" | "b" | "both"`.

**Protection** — whether the circuit is protected: `protection.requested` is `"diverse"` (default) or
`"single"`, `protection.achieved` is true only when the two legs share no graph edge and no leased
segment, and `protection.legs` is how many legs the graph actually allowed (1 means unprotected).

**Attenuator (pad)** — an inline loss fitted because the receiver is *too loud*: `attenuator` on a
budget result, `null` when the receiver is at or below its overload point. `overDb` is how far above
overload the link lands, `padDb` the smallest whole-dB pad that clears it, and `maxPadDb` the most the
design margin and the class budget can absorb, because a pad is ODN loss like any other.

**`routedM` / `ownM` / `lengthM`** — the same leg measured three ways, because they answer three
different questions: `routedM` is what the graph measured between the two snapped site nodes;
`spurM` is the site-to-edge drops; `ownM` is `routedM + spurM` — the cable you buy, and what the BOM
carries; `lengthM` is `ownM + leasedM`, everything the light travels along. A leased segment moves
`lengthM` and the budget, never `ownM` and never `bom.cableM`.

## Design and refusal

**Demand** — the address list a design is synthesised from (CSV or JSON, header by name, latitude and
longitude required).

**Synthesis** — choosing a topology (PON, active over tree, active home run) and producing the plant,
the budgets and the bill of materials for a demand.

**Refusal** — an explicit rejection that names the address or the row responsible. The alternative — a
straight line drawn to a property that has no route — is never acceptable.
