# 0003 — The catalogue is standards-derived, with provenance

**Status:** accepted (2026-11-23)

## Context

A planner is only as honest as its weakest figure. Vendor datasheets are the best source and the worst
thing to invent: a made-up insertion loss produces a design that passes on screen and fails in the field.
At the same time a catalogue with three parts in it cannot design anything.

## Decision

Every part carries:

- the figures the engine uses;
- `sourceUrl` — the standard, the class limit or the datasheet the figures came from;
- `notes` — what kind of figure each one is (published datasheet, ITU class limit, typical), and that it
  must be replaced with the part actually purchased.

The first catalogue is therefore built from standards (G.652.D / G.657.A2 attenuation, typical PLC
insertion loss, ITU-T class budgets) rather than from a vendor list. A part with no `sourceUrl` is a
validation error for every kind where one is required.

## Consequences

- A wrong figure is a bug with an owner, not an opinion: fix the part and its note.
- Adding a vendor part is welcome when the datasheet is real; filling a table with plausible numbers is
  not.
- Designs state their assumptions, so a budget can be argued with.
