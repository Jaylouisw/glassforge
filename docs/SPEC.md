# The model

What a design *is* in Glassforge, and which decisions the engine makes for you. Read this before
changing behaviour; the tests assert what is written here.

## 1. The plant is a tree

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

Rules the engine enforces:

- **Exactly one `olt` node.** Every ONT has exactly one path back to it.
- **Every span names a cable model and a measured length in metres.** A span with no length is
  refused, because the bill of materials is a number somebody spends money against.
- **Nodes and spans have unique ids.** The project layer generates `n1`, `n2`, `s1`, …; the API
  accepts supplied ids and refuses duplicates.
- **A cycle or an extra span is a warning, not a refusal.** You may be mid-drawing. A *contradiction*
  (two OLTs, an unknown splitter model, a split ratio over the class limit) is an error.

Why a tree and not a general graph: every number the planner produces — budget, splice diagram, cable
order — is derived from the path between the OLT and one ONT. A general graph would let two of those
three describe different networks.

## 2. A path becomes a budget

`network.designForOnt(plant, ontId, registry)` traces the path and applies these modelling choices:

| Element on the path | What it costs in the budget |
|---|---|
| A span | fibre loss = `attenuation(wavelength) × lengthM / 1000` from **its own cable spec** |
| A `closure` node | **one splice** (a through-splice as the thread passes) |
| A `splitter` node with `termination: "spliced"` | splitter insertion loss + **one splice** on the input side |
| A `splitter` node with `termination: "connectorised"` | splitter insertion loss + **two connectors** |
| The OLT port | **one connector** |
| The ONT | **one connector** |

That table is the whole model, and it is deliberately explicit: a design where splitters are
connectorised is 0.6 dB worse than the same design with cassettes, and the planner should say so
rather than average it away.

## 3. Two verdicts, not one

A design passes only if **both** hold:

1. **Receiver headroom.** `rxPower − sensitivity ≥ marginDb` (default 3 dB), and `rxPower` is not above
   the receiver's overload point.
2. **PON class budget.** `ODN loss ≤ class budget` for the OLT's PON and class (GPON B+ 28 dB, C+ 32,
   C++ 35; XGS-PON N1 29, N2 31, E1 33, E2 35).

They fail independently. A link can hear fine and still be outside what the OLT vendor supports —
`test/budget-optics.test.js` has exactly that case. Verdicts are `ok`, `marginal` (passes, but with
under 2 dB above the margin or under 1 dB of class headroom) and `fail`.

Every budget returns its `breakdown`: one line per fibre span, splice group, connector group and
splitter, each with a `db` value. A verdict without its arithmetic is not reviewable.

## 4. Length is not the line on the map

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

The BOM is per cable model, with `designM`, `drums`, `purchaseM` and `spareM`, plus a per-span line so
the total can be traced back to the map.

## 5. Strands are addressed the way the tray is

`fiber.addressFor(31)` → `{ tube: 3, fiber: 7, label: 'T03-F07', fiberColor: red, tubeColor: green }`,
because that is what is written on the tray in a closure. `fiber.parseAddress` accepts `T03-F07`,
`t3f7`, `3-7`, `3/7` and a bare strand index.

`spans[].strands` lists the strand indices **in use** on that span. The ledger reports used, spare and
utilisation per span, and flags overbooking: 14 strands assigned to a 12-fibre cable is a real drum
somebody cannot splice, not a cosmetic warning.

An absent `strands` array means *nothing in use* — spare capacity, not zero capacity.

## 6. Projects and undo

`engine/project.js` is pure data in, pure data out: `apply(project, op)` returns a **new** project and
never mutates its input, and refused edits return `{ error }` with a reason and no project.

History keeps the last **50** states. `undo(project)` pops one and returns the previous state, so the
fifty-first edit is the one that becomes permanent. The server persists projects as JSON under
`GF_DATA/projects/<id>.json`, written to a temp file and renamed.

## 7. What the engine refuses to guess

- A cable with no attenuation figure at the requested wavelength → **error**, never zero.
- A GPON OLT with an XGS-PON ONT → **error**; they cannot share a PON.
- An unknown part model → **error** naming the models that do exist.
- A split ratio beyond the OLT's `maxSplitRatio` → **error**.
- A span with no measured length → **error** at BOM time.

The rule behind all five: a planner that invents a plausible number produces a design that fails on
site, weeks later, where the cost is a crew and a drum of cable rather than a stack trace.
