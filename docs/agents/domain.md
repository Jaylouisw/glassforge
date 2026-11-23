# Domain Docs

How the development skills consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root — the vocabulary the engine, the tests and the issues all use.
- **`docs/adr/`** — read the decisions that touch the area you are about to work in, and say so when
  your output contradicts one rather than silently overriding it.

Single-context repo: one glossary, one ADR directory. There is no `GLOSSARY-MAP.md`.

If a term you need is not in the glossary, that is a signal: either you are inventing language the
project does not use (reconsider), or there is a real gap (note it and let the glossary grow).

## Keeping it true

The glossary describes the engine as it is, not as it is planned. When a change adds or renames a
concept, the glossary and the spec land in the same pull request; a term that exists only in a
conversation is a term the next agent will get wrong.
