# The optical numbers

Every figure in the budget, where it comes from, and how it is used. If a number here disagrees with
a standard, the standard wins and this file is the bug.

## Fibre attenuation

Single-mode G.652.D and G.657.A2 attenuation the shipped cable parts carry:

| Wavelength | G.652.D (dB/km used) | G.657.A2 (dB/km used) | Used for |
|---|---|---|---|
| 1310 nm | 0.35 dB/km | 0.35 dB/km | GPON upstream, XGS-PON upstream |
| 1490 nm | 0.22 dB/km | 0.22 dB/km | GPON downstream |
| 1550 nm | 0.21 dB/km | 0.21 dB/km | RF overlay / future |

These are **typical installed figures, not the recommendations' maxima**. ITU-T G.652 (characteristics
of a single-mode optical fibre) and G.657 (bend-insensitive fibre) put the limit at 0.40 dB/km across
1310-1625 nm and 0.30 dB/km across 1530-1565 nm, and G.657.A2 publishes the same attenuation maxima as
G.652.D. 1490 nm is interpolated between those two published windows: no ITU-T recommendation publishes
a 1490 nm attenuation figure of its own, so 0.22 dB/km is a working number, not a citation. Every
shipped cable says exactly this in its `notes` and points `sourceUrl` at the recommendation; a real
construction-grade budget should use the test report that ships with the drum.

The engine reads the figure **per cable part and per wavelength**. A cable that publishes no figure at
the wavelength being budgeted is an error — treating it as zero-loss glass produces a design that
says "OK" and does not light.

## Splice and connector loss

| Element | Typical | Acceptance limit | Used by default |
|---|---|---|---|
| Fusion splice | 0.10 dB | 0.15 dB | 0.10 dB |
| Mechanical splice | 0.30 dB | 0.50 dB | 0.30 dB |
| SC/APC mated pair | 0.30 dB | 0.50 dB | 0.30 dB |
| SC/UPC mated pair | 0.30 dB | 0.50 dB | 0.30 dB |
| LC/APC mated pair | 0.25 dB | 0.50 dB | 0.25 dB |

Connector figures follow IEC 61753-1 grades; splice figures are the values contracts commonly accept.
The engine charges **one connector per mating**, so an OLT port plus an ONT is 2 × 0.3 dB.

## Splitters

A PLC splitter has two loss components:

- **split loss** — the unavoidable `10 × log10(ratio)`, e.g. 9.03 dB for 1:8;
- **excess loss** — the insertion loss above the ideal, which is what a datasheet publishes.

The engine stores both and sums them, so a 1:8 cassette with 10.5 dB insertion loss is modelled as
9.03 + 1.47 dB. Shipped parts:

| Ratio | Insertion loss used | Split | Excess |
|---|---|---|---|
| 1:2 | 3.6 dB | 3.01 | 0.59 |
| 1:4 | 7.2 dB | 6.02 | 1.18 |
| 1:8 | 10.5 dB | 9.03 | 1.47 |
| 1:16 | 13.8 dB | 12.04 | 1.76 |
| 1:32 | 17.1 dB | 15.05 | 2.05 |
| 1:64 | 20.5 dB | 18.06 | 2.44 |
| 1:128 | 23.8 dB | 21.07 | 2.73 |

These are typical values for a good PLC cassette, not a guarantee: replace them with the purchased
part's datasheet. The 1:128 row is the one that needs it most: published figures for that ratio span
23.5 to 24.5 dB, because it is the last single-chip ratio and some vendors build it as two chips.
A splitter with 1.2 dB of excess loss where you assumed 0.5 dB is half a kilometre of reach.

## PON classes

| PON | Class | ODN budget | Practical split | Reference |
|---|---|---|---|---|
| GPON | B+ | 28 dB | 1:64 | ITU-T G.984.2 |
| GPON | C+ | 32 dB | 1:128 | ITU-T G.984.2 |
| GPON | C++ | 35 dB | 1:128 | ITU-T G.984.2 Amd 1 |
| XG-PON | N1 | 29 dB | 1:64 | ITU-T G.987.2 |
| XG-PON | N2 | 31 dB | 1:64 | ITU-T G.987.2 |
| XG-PON | E1 | 33 dB | 1:64 | ITU-T G.987.2 |
| XG-PON | E2 | 35 dB | 1:64 | ITU-T G.987.2 |
| XGS-PON | N1 | 29 dB | 1:64 | ITU-T G.9807.1 |
| XGS-PON | N2 | 31 dB | 1:128 | ITU-T G.9807.1 |
| XGS-PON | E1 | 33 dB | 1:128 | ITU-T G.9807.1 |
| XGS-PON | E2 | 35 dB | 1:128 | ITU-T G.9807.1 |

XG-PON and XGS-PON are two different PON types, not two spellings of one: XG-PON carries 9.953 Gbit/s
down and 2.488 Gbit/s up, XGS-PON carries 9.953 Gbit/s both ways. They share the N1/N2 loss figures
and the engine keeps them apart — an `xg-pon` OLT with an XGS-PON ONT is refused rather than budgeted
(`the OLT is xg-pon and the ONT is xgs-pon - they cannot share a PON`). The XG-PON rows claim 1:64
because that is the minimum G.987.1 clause 8.5 requires; 1:128 is an operator option the line card
has to state for itself.

The class budget is a check on the **ODN loss** (fibre + splices + connectors + splitters), separate
from the receiver headroom check. Both have to pass.

## The formula

Downstream (OLT → ONT), worst case:

```
P(rx) = P(tx,min) − [ Σ fibre attenuation × length
                    + Σ splice loss
                    + Σ connector loss
                    + Σ splitter insertion loss
                    + allowance ]

headroom       = P(rx) − sensitivity(ONT)
class headroom = class budget − ODN loss
```

Upstream (ONT → OLT) uses 1310 nm, the ONT's `txPowerDbmMin`, and the **OLT's** receiver sensitivity
and overload — the same spans, different endpoints. The engine refuses a GPON OLT paired with an
XGS-PON ONT rather than inventing a symmetric answer.

The wavelength is not free to move with the direction. The budget refuses an upstream figure at any
wavelength but 1310 nm and a downstream one at 1310 nm, because the only thing `wavelength` changes is
the fibre loss, so the wrong carrier quotes a loss the link never sees: the same 16 km B+ plant through
a 1:64 is `fail` upstream at 1310 nm — 16.0 km × 0.35 = 5.60 dB of fibre, ODN 27.10 dB, headroom
1.40 dB against a 3 dB margin — and would read `marginal` at 1550 nm (16.0 × 0.21 = 3.36 dB, ODN
24.86 dB, headroom 3.64 dB). Downstream may be 1490 nm or 1550 nm, the RF overlay carrier.

## A worked example

GPON C+, 3.0 km of 24F G.652.D, one 1:8 splice-terminated cassette, 4 fusion splices, 2 connectors:

```
fibre      3.0 km × 0.22 dB/km        =  0.66 dB
splices    4 × 0.10                   =  0.40 dB
connectors 2 × 0.30                   =  0.60 dB
splitter   9.03 + 1.47                = 10.50 dB
                                        --------
ODN loss                              = 12.16 dB   (class budget 32 dB → 19.84 dB spare)

P(rx)      = 3.0 dBm − 12.16          = −9.16 dBm
headroom   = −9.16 − (−30)            = 20.84 dB   (design margin 3 dB)
verdict    = ok
```

That is `test/budget-optics.test.js`, to the digit. If you change a loss figure, that test is where
the disagreement surfaces.

That design is in the band as well: +7 dBm at the top of the C+ window puts −5.16 dBm on an ONT whose
overload is −8 dBm, so the same result carries `warnings` with `2.84 dB above -8 dBm at the 7 dBm top
of the window` and a `launchWindowPad` of 3 dB. The arithmetic above is unchanged — the band adds a pad
to buy, not a reason to fail.

## Too loud: the pad the link needs

Overload is the one failure that more power cannot fix. A long-reach optic on a short duct run, or an
OLT patched into a nearby ONT, delivers more than the receiver tolerates, and the remedy is an inline
attenuator — not a shorter budget, not more reach. Every budget therefore reports the pad:

```
overDb   = P(rx at the strongest launch) − overload    how far above the receiver's limit a hot
                                                       module lands
padDb    = ceil(overDb)                                the pad to buy (pads come in whole dB)
maxPadDb = floor(min(class headroom, headroom − marginDb))
atTxDbm                                                the launch `padDb` was sized for
```

**The pad is sized for the strongest launch, not the weakest.** A pad is fitted once, but the module
that lands in the chassis can sit anywhere in its own `txPowerDbmMin..txPowerDbmMax` window — a C+
line card may paint +3 or +7 dBm. A pad computed from the minimum launch is sized for the one case that
cannot hurt the receiver, and leaves the receiver above its overload point whenever the module runs hot.
So `overDb` and `padDb` are measured at the receiver power the transmitter's `txPowerDbmMax` produces
(or the `txDbm` the caller asked for), and `atTxDbm` records the launch that was used.

Whether a link is too loud at all is still decided at the **minimum** launch: that is the worst-case
loss the class verdict is built on. A span that is inside its overload point there reports
`attenuator: null`, and the reason a too-loud link carries names the launch the pad covers (`even at
the 7 dBm top of its launch window`). Inside at the floor is not always healthy, though — see the
band below.

`maxPadDb` exists because **a pad is ODN loss**: it spends the same budget the route spends. A 5 dB pad
on a link with 4 dB of class headroom does not pass. When `maxPadDb < padDb` the design is
contradictory — too loud *and* too tight — so no pad satisfies both and the reason says so instead of
naming a number that would fail on site. Pads are bought in whole dB, so a 14.6 dB allowance funds
14 dB, and none at all is a plate somebody orders.

### The band between the two launches

Judging overload at the floor leaves a band in which the design is clean with a cold module and over
the receiver's limit with a hot one. For a C+ card, whose window is +3..+7 dBm, against an ONT whose
overload is −8 dBm, the band is every ODN between 11 and 15 dB — an ordinary 1:8 estate with a short
feeder. The engine reports that band instead of passing it in silence:

- `launchWindowPad` on the result is the pad the band needs: the same
  `{ overDb, padDb, maxPadDb, atTxDbm, fits }` object as `attenuator`, sized at the top of the window.
  The two are mutually exclusive — `attenuator` means the floor launch is already too loud, and its
  `reasons` already name the pad; `launchWindowPad` means only the ceiling is.
- `warnings` gains a sentence naming the receiver, the receive power at each end of the window, the
  overshoot and the pad to buy: `the ONT gpon-ont-4ge is inside its overload point only at the
  bottom of the OLT gpon-c-plus-8 launch window: -8.87 dBm at 3 dBm, but 3.13 dB above -8 dBm at the
  7 dBm top of the window - fit a 4 dB inline pad (up to 18 dB still passes the 3 dB margin and the
  class budget)`.
- The verdict does not move: that case is `ok` with no `reasons`, because which launch a design is
  signed off at is a product decision still open in issue #5 (the launch-window verdict). Every
  surface repeats the warning — the Signal tab per ONT, and both the printed plan and a synthesised
  design once for the whole plant through the same `budget.launchWindowNote`: a synthesised design
  counts the ONTs in the band as `metrics.launchWindowOnts` and puts the sentence in `warnings`, and
  the plan opens its budget warnings with it.

A script that reads `verdict` alone therefore misses a plan that only holds while every line card
lands at the bottom of its window: read `warnings` with the verdict.

The EX example in `test/parts-long-reach-optics.test.js`: 1 km of G.652.D and two connectors is 0.95 dB
of loss, so a 1000BASE-EX pinned at the 3 dBm top of its −1..+3 dBm window (`txDbm: 3`) receives
+2.05 dBm at a receiver whose overload is +1 dBm — 1.05 dB too loud, so 2 dB is the smallest pad that
clears it, and 20 dB is the most the 21 dB link budget (less 0.95 dB of loss, 20.05 dB, floored) and the
3 dB margin allow. Cisco's own 5 dB pad sits inside that window. The same span with no `txDbm` lands at
−1.95 dBm at the minimum launch, inside the overload point: the link is `ok` with `attenuator: null`,
and it is in the band — +2.05 dBm at the +3 dBm ceiling is 1.05 dB over the +1 dBm overload, so its
`warnings` names a 2 dB launch-window pad. A hot module in that chassis is exactly what the pad
arithmetic is for.

## What this model does not include

- **Chromatic and polarisation-mode dispersion budgets** — a reach question, not a loss question.
- **Reflectance / ORL**, and the APC-vs-UPC return-loss requirement at an analogue overlay.
- **Aging and temperature margin** as separate terms; the design margin is one number covering them.
- **Splice loss distribution per event** — the engine uses one figure per splice model. A design with
  forty splices at the acceptance limit is a different risk from forty at typical, and the planner
  cannot tell you which you have.
