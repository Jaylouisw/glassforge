# The model

What a design *is* in Glassforge, and which decisions the engine makes for you. Read this before
changing behaviour; the tests assert what is written here.

## 1. The plant is a tree, and its head-end decides the technology

```js
{
  name: 'Barrio Norte',
  nodes: [
    { id: 'n1', type: 'olt',      model: 'gpon-c-plus-8',  name: 'OLT',     lat: 51.5,  lon: -0.1 },
    { id: 'n2', type: 'closure',  model: 'mufa-inline-24', name: 'Mufa 1',  lat: 51.5005, lon: -0.1 },
    { id: 'n3', type: 'splitter', model: 'plc-1x8-sca',    name: 'SPL 1:8', lat: 51.501, lon: -0.1 },
    { id: 'n4', type: 'ont',      model: 'gpon-ont-4ge',   name: 'Casa 30', lat: 51.5015, lon: -0.1 }
  ],
  spans: [
    { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 1200 },
    { id: 's2', from: 'n2', to: 'n3', cable: 'g652d-loose-12', lengthM: 150 },
    { id: 's3', from: 'n3', to: 'n4', cable: 'g657a2-drop-1',  lengthM: 45 }
  ]
}
```

A plant has exactly one **root**, and the root's type is the technology:

| Root | Technology | Customer end | Budget used |
|---|---|---|---|
| `olt` | PON | `ont` model | class budget (`opticalBudget`) |
| `headend` | active optical | `transceiver` model | the optic pair's launch − sensitivity (`pointToPoint`) |

A PON may contain splitters; an active plant may not. Both are the same node types otherwise — a
closure is a closure, a drop is a drop — which is what makes the cable side of the planner shared
between the two.

Rules the engine enforces:

- **Exactly one root** (`olt` or `headend`, never both). Every ONT has exactly one path back to it.
- **Every span names a cable model and a measured length in metres.** A span with no length is
  refused, because the bill of materials is a number somebody spends money against.
- **Nodes and spans have unique ids.** The project layer generates `n1`, `n2`, `s1`, …; the API
  accepts supplied ids and refuses duplicates.
- **A cycle or an extra span is a warning, not a refusal.** You may be mid-drawing. A *contradiction*
  (two OLTs, an unknown splitter model, a split ratio over the class limit, more strands on a span than
  its cable carries - §6) is an error.
- **A splitter has as many branches as it has ports.** The port count is the part's ratio, counted per
  site: a downstream splitter costs its parent one port, and a ninth drop on a 1:8 is a contradiction,
  because the OLT-level checks (deepest cascade, total ONTs) cannot see it — nine ONTs behind one 1:8
  is a cascade of 8, well inside any `maxSplitRatio`.

Why a tree and not a general graph: every number the planner produces — budget, splice diagram, cable
order — is derived from the path between the OLT and one ONT. A general graph would let two of those
three describe different networks.

## 2. Auto-design

`design.synthesise(demand, opts, registry)` builds PON, active-tree and active-home-run candidates from
a list of coordinates, validates and budgets each, and ranks the survivors by fibre-metres (or by a
supplied cost model). Every build is a tree over a **routing provider**:

- **straight line** — minimum spanning tree over `distance × routeFactor`;
- **street graph** — `opts.network` (KML, polylines or `{ edges }`): each terminal is snapped to the
  nearest edge, the tree is the union of shortest paths from the root, and every span carries its
  street geometry as `route`.

The provider is named in `routeMethod`, and a terminal the graph cannot reach within `maxSnapM` makes
that candidate infeasible with the address named. The algorithms, the clustering, the cable taper and
the modelling choices are in [AUTO-DESIGN.md](AUTO-DESIGN.md). Nothing in it is random, so the same
demand always produces the same design.

## 3. A path becomes a budget

`network.designForOnt(plant, ontId, registry)` traces the path and applies these modelling choices:

| Element on the path | What it costs in the budget |
|---|---|
| A span | fibre loss = `attenuation(wavelength) × lengthM / 1000` from **its own cable spec** |
| A `closure` node | **one splice** (a through-splice as the thread passes) |
| A `splitter` node whose part spec has `termination: "spliced"` | splitter insertion loss + **one splice** on the input side |
| A `splitter` node whose part spec has `termination: "connectorised"` | splitter insertion loss + **two connectors** |
| The OLT port | **one connector** |
| The ONT | **one connector** |

That table is the whole model, and it is deliberately explicit: a design whose splitters are
connectorised is 0.5 dB worse than the same design spliced (two connectors at 0.3 dB against one
fusion splice at 0.1 dB), and the planner should say so rather than average it away.

## 4. Two verdicts, not one

A design passes only if **both** hold:

1. **Receiver headroom.** `rxPower − sensitivity ≥ marginDb` (default 3 dB), and `rxPower` is not above
   the receiver's overload point. Overload is the failure more power cannot fix, so the result also
   reports the inline pad that clears it (`attenuator: { overDb, padDb, maxPadDb, atTxDbm, fits }`, or
   `null` when the receiver is at or below its overload point) — sized at the transmitter's strongest
   launch (`atTxDbm`), because one pad has to hold a module that may run hot — and because a pad is
   ODN loss, `maxPadDb` is the point where the margin and the class budget run out.

   Overload is judged at the **minimum** launch — the worst-case loss the class verdict is built on —
   so a receiver that is over its limit only at the top of the transmitter’s window is not an overload
   failure: it reports `attenuator: null`, plus `launchWindowPad` (the same object, sized at
   `txPowerDbmMax`) and a line in `warnings` naming the launch that overdrives it. Every surface
   repeats that warning. Whether the band should fail is open in issue #5 (the launch-window verdict);
   today the engine reports it and leaves the verdict where this section puts it.
2. **The plant's own budget.** For a PON, `ODN loss ≤ class budget` (GPON B+ 28 dB, C+ 32, C++ 35;
   XG-PON N1 29, N2 31, E1 33, E2 35; XGS-PON N1 29, N2 31, E1 33, E2 35). For an active link,
   `ODN loss ≤ launch(min) − sensitivity` for the optic pair, and the route must be inside the optic's
   reach — a link can be 3 dB inside its budget and still be 60 km down a 10 km optic.

They fail independently. A link can hear fine and still be outside what the OLT vendor supports —
`test/budget-optics.test.js` has exactly that case. Verdicts are `ok`, `marginal` (passes, but with
under 2 dB above the margin or under 1 dB of class headroom) and `fail`.

A `marginal` result carries `marginalReason`: one sentence naming the figure that is tight — the slack
above the design margin, the class headroom, or both — and `null` for `ok` and `fail`, because a failure
is named by `reasons` and must not be softened into a marginal.

Every budget returns its `breakdown`: one line per fibre span, splice group, connector group and
splitter, each with a `db` value. A verdict without its arithmetic is not reviewable.

## 5. Length is not the line on the map

```
design length = route + overlength% + (splices × 30 m) + (closures × 20 m) + extra reserve
purchase      = ceil(design length / drum) × drum
```

- Overlength defaults to **3%**: cable is pulled around bends, up poles and into trays, and a
  straight-line measurement is always short.
- A **splice reserve** of 30 m per splice and a **closure reserve** of 20 m per closure are the
  lengths that have to reach the tray and come back out.
- **Drums are rounded once per cable model**, on the total. Rounding per span buys a spare drum for
  every short run on the map.
- **The drum is the cable's own** (`parts/cable/*.json` `drumM`): 1-fibre drop ships on 1 km, trunk on
  2 km. A drum length assumed from the trunk ladder buys drop cable on a drum nobody sells it on.

The BOM is per cable model, with `designM`, `drumM`, `drums`, `purchaseM` and `spareM`, plus a
per-span line so the total can be traced back to the map. The per-span line carries **metres only**:
a drum count per span would contradict the model total it sits under, which is the rounding rule
above stated as a shape.

A span is one route, not always one cable. `spans[].bundles` is how many cables run it — auto-design
sets it above one when the span's fibres do not fit the largest cable in the ladder — and the purchase
and the strand ledger both count every cable, while `routeM` stays the measured route.

## 6. Strands are addressed the way the tray is

`fiber.addressFor(31)` → `{ tube: 3, fiber: 7, label: 'T03-F07', fiberColor: red, tubeColor: green }`,
because that is what is written on the tray in a closure. `fiber.parseAddress` accepts `T03-F07`,
`t3f7`, `3-7`, `3/7` and a bare strand index.

How many fibres a tube holds is a property of the **cable** (`fibersPerTube`, validated 1..24), not a
fixed twelve, and the address follows the cable the strand is in: `network.spliceTable` addresses every
row from the span's own cable part, so strand 25 is `T02-F01` in a 24-per-tube ribbon and `T03-F01` in
a 12-per-tube loose tube - two cables of different tube sizes spliced at one closure get one address
each, which is what the crew reads off the two trays. A span naming a cable the catalogue does not hold
falls back to the standard twelve rather than hiding the strand from the sheet.

`spans[].strands` lists the strand indices **in use** on that span. The ledger reports used, spare and
utilisation per span, and an overbooked span is **refused**, not coloured: 14 strands assigned to a
12-fibre cable is a real drum somebody cannot splice, so `network.validate` returns it as an error
(`span "s1" uses 14 strands of a 12-fibre cable`) and the save gate answers `400 the edit would leave
the plant invalid: span "s1" uses 14 strands of a 12-fibre cable`. The refusal reuses the ledger row's
own `error` sentence, so the tab and the save cannot disagree about what is overbooked;
`test/strand-overbooking-gate.test.js` is that refusal.

An absent `strands` array means *nothing in use* — spare capacity, not zero capacity.

## 7. Projects and undo

`engine/project.js` is pure data in, pure data out: `apply(project, op)` returns a **new** project and
never mutates its input, and refused edits return `{ error }` with a reason and no project.

History keeps the last **50** states. `undo(project)` pops one and returns the previous state, so the
fifty-first edit is the one that becomes permanent. The server persists projects as JSON under
`GF_DATA/projects/<id>.json`, written to a temp file and renamed.

## 8. What the engine refuses to guess

- A cable with no attenuation figure at the requested wavelength → **error**, never zero.
- A GPON OLT with an XGS-PON ONT → **error** from the budget, not from `network.validate`, which
  checks plant structure and capacity and says nothing about PON family. The refusal is
  `budget.opticalBudget`'s: `the OLT is gpon and the ONT is xgs-pon - they cannot share a PON`
  (`engine/budget.js`, the `olt.pon !== ont.pon` guard at the top of `opticalBudget` - named by symbol
  rather than by line, because a line number rots on the next edit that moves it). A plant that mixes
  them validates clean and fails at budget time.
- Two optics of different rates or wavelengths → **error**; they cannot form a link.
- A splitter in an active plant, or a transceiver at the customer end of a PON → **error**.
- An unknown part model → **error** naming the models that do exist, up to eight of them in plain
  string order (`g652d-loose-144` sorts before `g652d-loose-24`), then `, ...` when the catalogue holds
  more. Run against this build, `registry.get('cable', 'nope-9000')` answers `unknown cable model
  "nope-9000" - known models: g652d-loose-12, g652d-loose-144, g652d-loose-24, g652d-loose-48,
  g652d-loose-72, g652d-loose-96, g652d-ribbon-216, g652d-ribbon-288, ...` — the tail is the
  catalogue's, so it moves when a cable is added. An empty catalogue for that kind says so instead.
- A split ratio beyond the OLT's `maxSplitRatio` → **error**.
- A span with no measured length → **error** at BOM time.

The rule behind all of those: a planner that invents a plausible number produces a design that fails on
site, weeks later, where the cost is a crew and a drum of cable rather than a stack trace.

## 9. A link is a circuit, not a plant

A site-to-site link has two sites, an optic at each end, and (normally) two legs that must not share
duct. It is deliberately **not** modelled as a plant: two paths between the same pair of nodes is a
cycle, and §1 says a plant is a tree with one head-end. `link.design` returns a circuit instead:

- **every leg is measured on the supplied graph** (`street.diversePaths`), never by a straight line
  while a graph is present, and each leg keeps its street geometry as `route`;
- **a coincident pair has one leg.** When both sites snap to the same node of the graph — two buildings
  across one street, their drops landing in the same chamber - there is no duct between them to route,
  so `street.diversePaths` is not called (its refusal of two identical points is a guard on its own
  API, not a verdict on this link). The design is `legs: [{ "id": "a" }]` with `routedM: 0`,
  `diversity.method: "coincident"` and `achieved: false`; the chamber is the joint, so the two drops
  splice there (`splices: 2`, one closure) and `ownM` is the two drops;
- **the pair is the minimum-cost edge-disjoint pair** the graph allows (Suurballe), and when the graph
  allows none, the second leg is the path that shares the fewest metres — with every shared segment
  reported and its metres, because "diverse except 180 m at the building entry" is the true answer;
- **a shared joint is reported beside the shared metres.** Edge-disjoint legs can still meet in one
  chamber — two ducts on either side of one manhole, or a side street drawn from the middle of the
  main road, which `planarize` correctly turns into a junction — and one excavation there takes out
  both legs. `diversity.sharedNodes` names those interior vertices (the two sites are excluded) and a
  protected pair that still has one is **not** `achieved`, however clean the metre count reads;
- **each leg is budgeted separately** by `budget.pointToPoint`: reach, loss budget and overload are
  three verdicts per leg, and a reason is prefixed with the leg it belongs to;
- **a leased segment is fibre somebody else owns**: its stated length and loss are charged to the
  budget of the leg it rides and to the cost, and it never appears in the cable metres. A segment
  assigned to a leg the design did not build is reported as unattached (`attached: false`, summed in
  the `unattached*` fields), charged to nothing and bought by nobody — the light never enters it. A
  leased loss that is missing is an error, not a zero — §8 applies to rented fibre exactly as it
  applies to bought fibre.

A cable is bought for every leg the design built, because a protected circuit is two fibre paths; a
coincident pair built one leg, and is quoted one cable. Nothing here changes the PON or active-tree
paths: they share `computeOdn`, so a loss is computed once, in one place.
