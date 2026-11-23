# 0002 — Route on the street graph, and refuse rather than guess

**Status:** accepted (2026-11-23)

## Context

A design that multiplies straight-line distance by a route factor produces a number that looks like a
cable length and is not one. Jay's requirement, stated twice, is that the fibre is routed along the
streets.

## Decision

When a street/duct network is supplied, every length is measured by walking that graph:

1. build the graph, merging vertices within 1.5 m;
2. snap each property or site onto the nearest edge, splitting the edge at the projection;
3. join near-coincident geometry within the join tolerance, so a side street drawn from the middle of a
   main road is one junction rather than two components;
4. run Dijkstra from the root, take the union of the shortest paths, prune it back to a tree.

Straight-line distance survives only as the fallback for the case where no network was supplied, and then
`routeMethod` says `straight-line xN`. A property that cannot be reached is refused by address.

`dijkstra(graph, rootId)` (`engine/street.js`) is a plain shortest-path tree from one root, with a
deterministic node-id tie-break. The protected-circuit work sits beside it rather than inside it:
`diversePaths(graph, fromId, toId, opts)` takes the minimum-cost edge-disjoint pair (Suurballe over the
residual graph) and, when the graph allows none, the path that shares the fewest metres — `opts.method`
only labels the answer. Costs live on the arcs, so nothing has to be rebuilt to look for a second route.

## Consequences

- Reported lengths are walkable, comparable with a drum length, and reproducible from the geometry.
- The response has to carry `routeMethod` and the polyline, so a caller can tell a routed design from a
  fallback without reading the docs.
- Two-site links inherit the same rule: both legs are walked, and diversity is reported in metres.
