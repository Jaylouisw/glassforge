# The optical numbers

Every figure in the budget, where it comes from, and how it is used. If a number here disagrees with
a standard, the standard wins and this file is the bug.

## Fibre attenuation

Single-mode G.652.D and G.657.A2 attenuation used by the shipped cable parts:

| Wavelength | G.652.D (limit) | G.657.A2 (limit) | Used for |
|---|---|---|---|
| 1310 nm | 0.35 dB/km | 0.35 dB/km | GPON upstream, XGS-PON upstream |
| 1490 nm | 0.22 dB/km | 0.22 dB/km | GPON downstream |
| 1550 nm | 0.21 dB/km | 0.21 dB/km | RF overlay / future |

Source: ITU-T G.652 (characteristics of a single-mode optical fibre) and G.657 (bend-insensitive
fibre). These are **limits**, not a factory's measurements; a real construction-grade budget should
use the test report that ships with the drum. The parts say so in `notes`, and `sourceUrl` points at
the recommendation.

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

These are typical values for a good PLC cassette, not a guarantee: replace them with the purchased
part's datasheet. A splitter with 1.2 dB of excess loss where you assumed 0.5 dB is half a kilometre
of reach.

## PON classes

| PON | Class | ODN budget | Practical split | Reference |
|---|---|---|---|---|
| GPON | B+ | 28 dB | 1:64 | ITU-T G.984.2 |
| GPON | C+ | 32 dB | 1:128 | ITU-T G.984.2 |
| GPON | C++ | 35 dB | 1:128 | ITU-T G.984.2 Amd 1 |
| XGS-PON | N1 | 29 dB | 1:64 | ITU-T G.9807.1 |
| XGS-PON | N2 | 31 dB | 1:128 | ITU-T G.9807.1 |
| XGS-PON | E1 | 33 dB | 1:128 | ITU-T G.9807.1 |
| XGS-PON | E2 | 35 dB | 1:128 | ITU-T G.9807.1 |

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

## What this model does not include

- **Chromatic and polarisation-mode dispersion budgets** — a reach question, not a loss question.
- **Reflectance / ORL**, and the APC-vs-UPC return-loss requirement at an analogue overlay.
- **Aging and temperature margin** as separate terms; the design margin is one number covering them.
- **Splice loss distribution per event** — the engine uses one figure per splice model. A design with
  forty splices at the acceptance limit is a different risk from forty at typical, and the planner
  cannot tell you which you have.
