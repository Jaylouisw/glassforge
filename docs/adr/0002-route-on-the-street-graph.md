# 0002 — Route on the street graph, and refuse rather than guess

**Status:** accepted (2026-11-23); amended 2026-11-27 (step 2 — the graph is planarised, not only merged)

## Context

A design that multiplies straight-line distance by a route factor produces a number that looks like a
cable length and is not one. Jay's requirement, stated twice, is that the fibre is routed along the
streets.

## Decision

When a street/duct network is supplied, every length is measured by walking that graph:

1. build the graph, merging vertices within 1.5 m;
2. **planarise it** — `street.planarize`, which `street.buildGraph` calls: split every edge at a vertex
   that lies on its interior, then join two lines that cross with no vertex on either, and split again
   because the node a crossing creates is itself an interior vertex of the lines it joined;
3. snap each property or site onto the nearest edge, splitting the edge at the projection;
4. run Dijkstra from the root, take the union of the shortest paths, prune it back to a tree.

Straight-line distance survives only as the fallback for the case where no network was supplied, and then
`routeMethod` says `straight-line x<routeFactor>` — `straight-line x1.2` at the default 1.2, the
factor itself rather than a literal `N`. A property that cannot be reached is refused by address.

`dijkstra(graph, rootId)` (in `engine/street.js`) takes no options: it returns the shortest-path tree
from the root, deterministic on ties. A second, diverse leg is not a re-costed Dijkstra from the same
graph — it is `diversePaths(graph, fromId, toId, opts)` (also in `engine/street.js`), which finds the
minimum-cost edge-disjoint pair over the residual graph (Suurballe with Johnson potentials, the first
path's arcs available reversed at negative cost) and falls back to the path sharing the fewest metres
when the graph offers no second route.

## Amendment, 2026-11-27

Step 2 used to read "join near-coincident geometry within the join tolerance, so a side street drawn
from the middle of a main road is one junction rather than two components". The join tolerance does not
do that, and the code never relied on it to: a side street drawn *from* a point on the main road shares
no vertex with it, so merging leaves two components and every property on the side street is reported
unreachable. Planarising is the step — `splitAtInteriorVertices` cuts the main road under the side
street's endpoint, and `joinCrossings` does the same for two lines that cross with no vertex on either
(pruned by bounding boxes, and a graze of under 0.05 m off the other line not counted as a crossing).

Driven, not read. A main road `51.5000,-0.1020 → 51.5000,-0.0960` plus a side street starting at
`51.5000,-0.0990` (its midpoint, no shared vertex): merge-only leaves 4 nodes / 2 edges in **2
components**, and `planarize` returns 1 split leaving the same graph in **1 component** with 3 edges.
For a transversal crossing (two lines through `51.5000,-0.1000`) the merge does nothing at all — 2
components — and `planarize` joins them into 1 component with 4 edges. `test/street-routing.test.js`
("a side street drawn from the middle of a main road is joined to it") is the regression case.

## Consequences

- Reported lengths are walkable, comparable with a drum length, and reproducible from the geometry.
- The response has to carry `routeMethod` and the polyline, so a caller can tell a routed design from a
  fallback without reading the docs.
- Two-site links inherit the same rule: both legs are walked, and diversity is reported in metres.
- Planarising joins any two lines that cross at grade, because the geometry carries no level: a duct
  passing *under* a street must be offset in the import or given its own node (`docs/AUTO-DESIGN.md`).
