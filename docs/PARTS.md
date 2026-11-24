# The parts catalogue

One JSON file per part: `parts/<kind>/<model>.json`. The `model` field must equal the filename, and
the `kind` must equal the directory. Adding a part is a file, not a code change.

`node scripts/audit-parts.js` prints what loaded and what the validator thinks; `npm test` refuses an
invalid part.

## Common fields

| Field | Required | Meaning |
|---|---|---|
| `kind` | yes | `cable`, `splitter`, `olt`, `ont`, `transceiver`, `closure`, `connector`, `splice` |
| `model` | yes | lowercase slug, unique, equal to the filename |
| `label` | yes | what a user picks from a list |
| `vendor` | no | `generic` for a standards-derived part |
| `tags` | no | free-text search terms |
| `sourceUrl` | see below | where the figures came from |
| `notes` | no | the caveat a reader needs (e.g. "typical, not a datasheet") |

`sourceUrl` is **required** for `cable`, `splitter`, `olt`, `ont` and `transceiver`: those carry the
figures a verdict depends on. It is optional for `closure`, `connector` and `splice`, but a part without one should say
in `notes` where its number came from.

## cable

```json
{
  "kind": "cable", "model": "g652d-loose-24", "label": "G.652.D loose-tube 24F",
  "fiberCount": 24, "fibersPerTube": 12, "construction": "loose-tube",
  "fiberStandard": "G.652.D", "use": ["feeder", "distribution"], "drumM": 2000,
  "attenuationDbPerKm": { "1310": 0.35, "1490": 0.22, "1550": 0.21 }
}
```

- `fiberCount` 1..3456; `fibersPerTube` 1..24 (12 for a standard loose tube, 12 per ribbon).
- `attenuationDbPerKm`: at least one of `1310`, `1490`, `1550`, each in (0, 2] dB/km. **A window with
  no figure is a window the engine refuses to budget**, by design.
- `use`: `feeder`, `distribution`, `drop`, `indoor`.
- `construction`: `loose-tube`, `ribbon`, `tight-buffer`.

## splitter

```json
{
  "kind": "splitter", "model": "plc-1x8-sca", "label": "PLC 1x8 SC/APC",
  "ratio": 8, "splitLossDb": 9.03, "excessLossDb": 1.47,
  "termination": "spliced", "technology": "plc"
}
```

- `ratio` must be a power of two from 2 to 128.
- `splitLossDb` defaults to `10 × log10(ratio)`; if given and more than 0.15 dB from that, the
  validator warns — the split is physics, the excess is the part.
- `excessLossDb` is required, 0..3.
- `termination`: `spliced` (cassette arrives with pigtails to splice, costs one splice) or
  `connectorised` (costs two connectors). This changes the budget by ~0.5–0.6 dB, so it is not a
  cosmetic field.

## olt

```json
{
  "kind": "olt", "model": "gpon-c-plus-8", "label": "GPON OLT class C+, 8 ports",
  "pon": "gpon", "class": "C+",
  "txPowerDbmMin": 3, "txPowerDbmMax": 7,
  "rxSensitivityDbm": -32, "rxOverloadDbm": -12,
  "budgetDb": 32, "ports": 8, "maxSplitRatio": 128
}
```

The example is `parts/olt/gpon-c-plus-8.json`, field for field: `test/parts-doc-examples.test.js`
parses every ```json block on this page and fails when a figure disagrees with the part it names, which
is how the -30/-8 class B+ pair above was caught still sitting here after the part was corrected.

- `pon`: `gpon`, `xg-pon`, `xgs-pon`. `class` must have a published budget; `budgetDb` that differs by
  more than 0.5 dB from the published figure warns.
- `ports` and `maxSplitRatio` are what the capacity check uses — an ONT count beyond
  `ports × maxSplitRatio` is an error, and a splitter cascade beyond `maxSplitRatio` is too.

## ont

```json
{
  "kind": "ont", "model": "gpon-ont-4ge", "label": "GPON ONT 4x GE",
  "pon": "gpon", "txPowerDbmMin": 0.5, "txPowerDbmMax": 5,
  "rxSensitivityDbm": -30, "rxOverloadDbm": -8, "ports": { "ge": 4 }
}
```

`pon` must match the OLT's, or the engine refuses the pair. Sensitivity must be below overload.

## transceiver

An optic: the two ends of an active (point-to-point) link. This is what an active design is budgeted
against, instead of a PON class.

```json
{
  "kind": "transceiver", "model": "sfp-plus-10g-lr-10km", "label": "SFP+ 10GBASE-LR 10 km",
  "speedMbps": 10000, "wavelengthNm": 1310, "reachM": 10000,
  "txPowerDbmMin": -8.2, "txPowerDbmMax": 0.5,
  "rxSensitivityDbm": -14.4, "rxOverloadDbm": 0.5,
  "polish": "upc"
}
```

- `speedMbps` 1000 / 10000 / 25000 / 100000; `wavelengthNm` in [1260, 1675]; `reachM` up to 200 km.
- The link budget is `txPowerDbmMin − rxSensitivityDbm` (10GBASE-LR: 6.2 dB), and reach is checked
  separately. Sensitivity must be below overload.
- Both ends must agree on speed and wavelength, or `budget.pointToPoint` refuses the pair.

## closure

```json
{
  "kind": "closure", "model": "nap-8", "label": "NAP 8-port",
  "type": "nap", "ports": 8, "spliceCapacity": 24, "trays": 2
}
```

`type`: `nap`, `mufa`, `inline`, `handhole`, `cabinet`, `splitter-box`. A closure whose `ports` are
outnumbered by the cables running into it warns (the code compares cables into the node against
`ports`); `spliceCapacity` is what stops an over-stuffed tray.

## connector and splice

```json
{ "kind": "connector", "model": "sc-apc", "label": "SC/APC connector pair", "polish": "apc", "lossDb": 0.3, "maxLossDb": 0.5 }
{ "kind": "splice", "model": "fusion", "label": "Fusion splice", "lossDb": 0.1, "maxLossDb": 0.15 }
```

`polish`: `pc`, `upc`, `apc`. `lossDb` is what the engine charges per mating/splice; `maxLossDb` is the
acceptance limit a contract would use, kept for the report rather than the arithmetic.
