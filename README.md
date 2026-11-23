# Glassforge

**An open-source fibre network planner — PON and active optical.** Draw a fibre route, document every
splice, check the optical power budget, and get the cable to buy. Or paste a list of addresses and let
it design the topology: PON with splitters, or active Ethernet over a shared cable tree. One project,
on your own machine, with no account and no subscription.

[![CI](https://git.jayw.uk/jaylouisw/glassforge/badges/workflows/ci.yml/badge.svg)](https://git.jayw.uk/jaylouisw/glassforge/actions?workflow=ci.yml)

It is the open counterpart to the hosted FTTH planners: the same three artefacts a fibre deployment
actually runs on — the **route**, the **splice diagram**, and the **optical budget** — built as a
zero-dependency Node app you can run on a laptop in a site office.

```bash
git clone https://git.jayw.uk/jaylouisw/glassforge.git
cd glassforge
node server/index.js          # then open http://127.0.0.1:8000
```

Node 18 or newer. No `npm install`, because there is nothing to install: the server is `http` and
`fs`, the UI is one HTML file and two scripts, and the engine is plain CommonJS.

<!-- parts:start -->
**37 parts across 8 kinds** — 8 cables, 6 splitters, 5 OLTs, 3 ONTs, 5 transceiver, 5 closures, 3 connectors, 2 splices.
<!-- parts:end -->

## What it does today

| Piece | Behaviour |
|---|---|
| **Plant** | A tree with one head-end: OLT → feeder → closures and splitters → drop → ONT for a PON, or head-end → cable tree → ONTs for active Ethernet. Duplicate ids, unknown models, over-split PONs and unmeasured spans are refused; a dangling node is a warning, not a wall. |
| **Optical budget** | Worst-case loss both ways: fibre by the metre, splices, connectors, splitters. Two verdicts — receiver headroom against a design margin, and the plant's own budget (a PON class, or the optic pair's launch-minus-sensitivity for an active link). |
| **Auto-design** | Paste addresses plus a head-end and it builds PON (at each splitter ratio), active-over-a-tree and active home-run, validates and budgets every one, and ranks them by fibre-metres or by your cost model. Winners are applicable to the project in one undoable step. |
| **Street routing** | Import the street or duct network (KML/KMZ) and every run is measured along it and drawn along it: snaps each property to the nearest edge, routes the union of shortest paths, keeps the polyline on the span. Anything the network cannot reach is refused by address, not connected by a straight line. |
| **Site-to-site links** | Two sites, an optic at each end, both legs routed along the imported duct graph: edge-disjoint A/B legs where the graph allows it, the shared metres named where it does not, one budget verdict per leg, and leased segments costed and budgeted but never bought as cable. |
| **Cable to buy** | Route length + 3% overlength + 30 m per splice + 20 m per closure, itemised, rounded up to whole drums **per cable model**. |
| **Splice diagram** | TIA-598 colours and `T03-F07` addresses, from the same table the engine uses, with per-span strand usage and overbooking detection. |
| **KML / KMZ import** | Bring in a route drawn in Google Earth. Reports routes, points, duplicates skipped, and what it did not understand. |
| **Projects** | Saved as JSON under `data/`, with 50 steps of undo. Nothing leaves the machine. |

## Design from a list of addresses

```bash
curl -s http://127.0.0.1:8000/api/design/synthesise -H 'Content-Type: application/json' -d '{
  "demand": "label,lat,lon\nCasa 1,51.5000,-0.1000\nCasa 2,51.5005,-0.0998\nCasa 3,51.5010,-0.0996",
  "headEnd": { "lat": 51.4985, "lon": -0.1004, "name": "PoP" }
}'
```

It returns every candidate with its metrics and the reason it lost, the winner's plant and runs, and a
`rationale` quoting the numbers the ranking used:

```
Chosen: PON 1:8 with 3 splitter site(s): 24 ONT(s), 2987.7 m of cable (26987.7 fibre-metres),
        3 splitter(s), 21 closure(s), worst headroom 20.7 dB.
Rejected PON 1:16 with 2 splitter site(s): feasible but needs 2857.2 m of cable and 28188.9
        fibre-metres (1.04x)
Rejected Active Ethernet over a shared cable tree, 1 Gb/s 1G-LX-10KM: feasible but needs 1788.5 m
        of cable and 58969.6 fibre-metres (2.19x)
```

Supply a street or duct network and the runs are **routed along it**; without one they are
straight-line × `routeFactor` (default 1.2). Every response says which it used (`routeMethod`), and
each run carries its `route` polyline when it was routed. Details, algorithms and the modelling
choices: [docs/AUTO-DESIGN.md](docs/AUTO-DESIGN.md).

## What it does not do yet

Being explicit, because a planner that quietly lacks a feature is worse than one that says so:

- **No basemap.** The canvas projects your coordinates and keeps the aspect ratio, but there are no
  street or satellite tiles: an offline-capable tile layer is a separate decision (and a cache).
- **No map download.** Street routing works on geometry you import; the server makes no outbound
  requests, so there is no built-in OSM/Google fetch.
- **No geocoding.** Addresses need coordinates in the input, for the same reason.
- **No active-equipment sizing.** Active designs count fibres and optics, not switch ports or uplinks.
- **No accounts, roles or multi-user editing.** One machine, one user, one file per project.
- **No OLT integration.** SmartOLT-style ONU synchronisation is not implemented and is not faked.
- **No PDF/PNG plan export.** The BOM and the splice table are on screen and in the API.
- **No field app.** A phone can open the UI, but there is no offline field mode.

## How it is put together

```
engine/     pure functions — fibre colours, parts registry, budget, lengths, plant, KML, projects
parts/      the catalogue, one JSON file per part (add a model = drop a file, no code change)
server/     HTTP surface and project storage: http + fs, nothing else
web/        the UI: index.html, app.js, scene.js, style.css — no framework, no build step
test/       one suite per behaviour, discovered by scripts/run-tests.js
docs/       SPEC.md (the model), AUTO-DESIGN.md (topology synthesis), OPTICAL.md (the numbers),
            PARTS.md, FIBRE-COLOURS.md, API.md
```

The engine has no HTTP, no disk and no clock in it. That is what lets the whole planning model be
exercised in milliseconds, and it is why `server/` is the only file that knows what a port is.

Read [docs/SPEC.md](docs/SPEC.md) before changing behaviour, [docs/AUTO-DESIGN.md](docs/AUTO-DESIGN.md)
before touching the synthesiser, and [docs/OPTICAL.md](docs/OPTICAL.md) before changing a loss figure.

## The parts catalogue

A part is a JSON file:

```json
{
  "kind": "splitter",
  "model": "plc-1x8-sca",
  "label": "PLC 1x8 SC/APC",
  "ratio": 8,
  "splitLossDb": 9.03,
  "excessLossDb": 1.47,
  "termination": "spliced",
  "sourceUrl": "https://www.itu.int/rec/T-REC-G.671/en"
}
```

Two rules the validator enforces, because they are the difference between a planner and a drawing
tool:

1. **A missing figure stays missing.** A cable with no attenuation published at 1490 nm cannot be
   budgeted at 1490 nm — the engine refuses rather than assuming free glass.
2. **A number from a datasheet says where it came from.** Cables, splitters, OLTs and ONTs carry
   `sourceUrl`. The figures shipped here are the standards' limits and typical insertion losses, and
   every one of them says so; replace them with the datasheet of the part you actually buy.

Adding a part is dropping a file in `parts/<kind>/` and running `node scripts/count-parts.js`. See
[docs/PARTS.md](docs/PARTS.md) for the field list per kind.

## Development

```bash
npm test                 # part counts, control bytes, Node 18 surface, every suite
node scripts/smoke-http.js
node scripts/audit-parts.js
node scripts/syntax-check.js
```

`npm test` is `node scripts/run-tests.js` plus the guards that catch the failures a green suite
cannot: a control byte inside a regex, an API that does not exist on Node 18, a README count that has
drifted from the catalogue.

Development happens on [the Forgejo instance](https://git.jayw.uk/jaylouisw/glassforge):
one issue ↔ one pull request, and the CI matrix has to be green before it merges.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT. See [LICENSE](LICENSE).
