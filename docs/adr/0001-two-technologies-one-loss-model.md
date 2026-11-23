# 0001 — Two technologies, one loss model

**Status:** accepted (2026-11-17)

## Context

The first release was PON-only: the plant was a tree of splitters and the second verdict was the ITU-T
class budget. Asking it a point-to-point question produced nonsense — a 12-fibre 5 km span with no
splitter came back as `0.45 dBm is above its overload point -8 dBm`, because the PON model has no notion
of a launch power or a receiver sensitivity.

Two ways forward: fork the engine into a "PON planner" and a "link planner" with separate loss code, or
keep one engine and make the root node type choose the model.

## Decision

One engine, one passive-loss calculation (`computeOdn`), two verdicts selected by the root node type:

- `olt` → PON: the class budget (28/32/35 dB), split ratio and cascade limits apply.
- `headend` → active: launch power minus sensitivity with the transceiver's own figures, plus reach and
  overload checks.

Transceivers are catalogue parts (`kind: transceiver`) with `speedMbps`, `wavelengthNm`, `reachM`,
launch power, sensitivity and overload.

## Consequences

- The passive side can never drift between the two models, because there is only one copy of it.
- A wrong answer must be fixed in the shared model rather than in one branch of it.
- Wavelength is a property of a part, not a global list; amplification and multi-wavelength systems
  remain out of scope.
