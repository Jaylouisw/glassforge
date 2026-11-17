## What this changes

<!-- One paragraph. If it fixes two things, it should be two PRs. -->

## Issue

Closes #

## How it was verified

<!-- The command you ran and what it printed. "Tests pass" is not a verification. -->

```
npm test
node scripts/smoke-http.js
```

## What it deliberately does not change

<!-- Behaviour left alone, and why. This is the field that stops a review argument later. -->

## Checklist

- [ ] One logical change (docs / CI / code in separate PRs)
- [ ] No new runtime dependency
- [ ] A test for the success **and** the refusal
- [ ] Counts and docs regenerated (`node scripts/count-parts.js`) if the catalogue changed
- [ ] `npm test` green on Node 18, 20 and 22
