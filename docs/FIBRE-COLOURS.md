# Fibre colours and strand addresses

TIA-598-D assigns twelve colours, in a fixed order, to the fibres of a tube and to the tubes
themselves. Every strand Glassforge emits is addressable the way the tray is labelled, because that is
how a technician in a manhole reads it.

| # | Colour | Hex used in the UI |
|---|---|---|
| 1 | blue | `#1f6fd0` |
| 2 | orange | `#f07f13` |
| 3 | green | `#2e9e4f` |
| 4 | brown | `#7b4a24` |
| 5 | slate | `#7a8493` |
| 6 | white | `#f0f0f0` |
| 7 | red | `#d62828` |
| 8 | black | `#1a1a1a` |
| 9 | yellow | `#f2c200` |
| 10 | violet | `#7b3fa0` |
| 11 | rose | `#e0568c` |
| 12 | aqua | `#1fb6c9` |

The sequence repeats every twelve, and tube 13 is blue again. A **fibre** past the twelfth in a tube
does not repeat plainly, though: it repeats with a tracer (below). The table lives in
`engine/fiber.js`, is served to the browser verbatim at `/fiber.js`, and is the same object the
splice diagram uses — two copies of TIA-598 is exactly the drift this project refuses.

## Fibres 13–24 in a tube: the tracer

TIA-598-D does not just restart the twelve colours for positions 13–24 — it repeats each one with a
**black tracer**, and the repeated black (position 20) takes a **white tracer**, because black on
black cannot be read in a tray.

| Fibre | Colour read off the tray |
|---|---|
| 1–12 | `blue` … `aqua`, plain |
| 13 | `blue with black tracer` |
| 14 | `orange with black tracer` |
| 20 | **`black with white tracer`** |
| 24 | `aqua with black tracer` |

`fiber.addressFor` returns `fiberColor: { name, hex, tracer }`; `tracer` is `null` for 1–12 and for a
tube of twelve or fewer, and `fiber.colorText` is the one place the two words are composed
(`blue with black tracer`). The splice schedule carries `tracer` on every row, and both the printed
plan and the browser's splice tab stripe the swatch, so `T01-F01` and `T01-F13` are two different
cells rather than one blue printed twice (gh#258).

**Above 24 the marking is the manufacturer's, not the standard's.** A Corning 24-fibre tube ships
fibre 20 as a *natural* fibre with a black tracer instead of a black one; that is a product variant.
The engine returns the base colour and no tracer past 24 rather than guessing — the T-number
identifies the fibre and the cable's construction sheet decides what the tracer is. `fibersPerTube`
is capped at 24, so no current catalogue row reaches that branch.

## Addresses

Counting is 1-based at both levels.

| Strand | Address | Tube colour | Fibre colour |
|---|---|---|---|
| 1 | `T01-F01` | blue | blue |
| 7 | `T01-F07` | blue | red |
| 12 | `T01-F12` | blue | aqua |
| 13 | `T02-F01` | orange | blue |
| 31 | `T03-F07` | green | red |
| 96 | `T08-F12` | black | aqua |

In a 24-fibre tube (`fibersPerTube: 24`, e.g. `atlas-lite-airblown-24`) the address is the same
`T01-F13` form but the colour carries a tracer; see the section below.

Accepted input forms: `T03-F07`, `t3f7`, `03-07`, `3/7`, and a bare `31` (a strand index).
Everything else returns `null`, and an address that is out of range is **not** a different answer:
`T00-F01` and `T03-F13` (a 12-fibre tube has no fibre 13) are `null` exactly as `garbage` is. The
`RangeError`s in `engine/fiber.js` belong to the addressing helpers, not to the parser: `addressFor`
refuses a strand index that is not a positive integer. A caller that needs to tell "not an address"
from "no such strand" compares the parsed `tube`/`fiber` against the cable's own `fibersPerTube`.

## Ribbon cable

A ribbon cable is one tube per ribbon, twelve fibres per ribbon, so the tube number is the ribbon
number. The address still reads `T05-F03`; the closure drawing says "ribbon 5, fibre 3". Beyond twelve
ribbons the tube colours repeat and the drawing needs the ribbon number written on it — which is why
the address keeps the tube component explicit rather than collapsing to a strand index.

## Why this is engine code and not a UI detail

The address is what the splice diagram, the strand ledger, the saved project and the API all resolve
through. A single bad name — a counter-suffixed label that advertises a tube the cable does not have —
propagates into labels, saved designs and a splice plan a crew follows. `fiber.addressFor` is the only
place a label is composed, and `test/fiber-colours.test.js` is what keeps it honest.
