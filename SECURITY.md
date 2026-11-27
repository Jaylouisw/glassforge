# Security

## Reporting

Report a vulnerability privately through GitHub's advisory form:
[open a draft security advisory](https://github.com/jaylouisw/glassforge/security/advisories/new) or contact the
maintainer directly. Please do not open a public issue for something exploitable.

Include the version (`/api/health`), what an attacker gains, and the smallest reproduction you have.
You will get an acknowledgement and a fix or a reasoned refusal — not silence.

## Scope

Glassforge is a single-user application intended to run on a local machine or inside a trusted
network. It has **no authentication**, and that is a design decision rather than an oversight:

- it serves the UI and the API on one port with no accounts, no sessions and no roles;
- it writes one JSON file per project under `GF_DATA`;
- it makes no outbound network requests.

**Do not expose it to the internet.** If you need to reach it from elsewhere, put it behind a VPN or
an authenticating reverse proxy, and treat anyone who can reach the port as able to read and rewrite
every project.

In scope, and interesting:

- path traversal in the static file handler or the project store (`../`, encoded forms, symlinks);
- JSON body handling: unbounded bodies, prototype pollution via `__proto__` keys in a project;
- a KML/KMZ file that makes the importer allocate or recurse without bound;
- the project validator accepting a design that later crashes a budget or BOM call.

Out of scope: denial of service by a user against their own machine, and anything that requires the
attacker to already be able to write to `GF_DATA`.
