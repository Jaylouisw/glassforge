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

The first twelve positions carry those colours plain. TIA-598-D then repeats them through position
48 and **marks every repeat**, because a bare repeat is two fibres a crew cannot tell apart in one
tray:

| Positions | Base colour plus | Exception, so the mark shows |
|---|---|---|
| 13–24 | a black tracer | 20 (black) takes a white tracer |
| 25–36 | a double black tracer | 32 (black) takes a double white tracer |
| 37–48 | a single green stripe | 39 (green) takes an orange stripe |

So a 24-fibre tube addresses `T01-F01 blue` and `T01-F13 blue with black tracer`, and a 432-fibre
ribbon cable — 36 ribbons of twelve — addresses ribbon 25 as `blue with double black tracer`, not as
a second tube 1. Above 48 the marking is left to agreement between maker and buyer, so the engine
returns the base colour and the tube/fibre number identifies the position; a 24-fibre tube with a
natural fibre at position 20 (Corning MiniXtend HD) is a product variant and its construction sheet
wins.

A splice row carries the marking twice: `marking` (`black tracer`, `double black tracer`, `green
stripe`, or `null` on positions 1–12) and `colourLabel` (`blue with black tracer`), which is the
string the printed plan and the browser diagram show. `colour` stays the base name, because the
swatch is that colour.

The table lives in `engine/fiber.ts` (compiled in place to `engine/fiber.js`, served to the browser
verbatim at `/fiber.js`), and is the same object the splice diagram uses — two copies of TIA-598 is
exactly the drift this project refuses.

## Addresses

Counting is 1-based at both levels. The table is a **12-fibre tube**: in a 24-fibre tube, strand 13
stays in tube 1 and reads `T01-F13 blue with black tracer`, which is the marking doing the work the
tube number does in a two-tube cable.

| Strand | Address | Tube colour | Fibre colour |
|---|---|---|---|
| 1 | `T01-F01` | blue | blue |
| 7 | `T01-F07` | blue | red |
| 12 | `T01-F12` | blue | aqua |
| 13 | `T02-F01` | orange | blue |
| 31 | `T03-F07` | green | red |
| 96 | `T08-F12` | black | aqua |

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
