# Triage Labels

The development skills speak in terms of five canonical triage roles. This file maps those roles to the
label strings used in this repo's tracker.

| Label in the skill set | Label in our tracker | Meaning                                  |
| ---------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`         | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`           | `needs-info`         | Waiting on the reporter for more detail  |
| `ready-for-agent`      | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`      | `ready-for-human`    | Needs a human decision or hardware       |
| `wontfix`              | `wontfix`            | Will not be actioned                     |

When a skill mentions a role ("apply the AFK-ready triage label"), use the label string from the right
column. The five labels live on the **GitHub repo** (`gh label list`,
ids 13–17, created through the API on 2026-11-23); creating them again is not part of triage, and
`GET /labels` is the authority on what exists.

`.github/labels.yml` is **not** the list above and not the tracker's truth: it declares issue
*category* labels (`bug`, `enhancement`, `parts`, `docs`, `ci`), which the issue templates apply and
which none of the five triage roles map to — and it is stale besides: a `GET /labels` on the repo
returns the five triage labels and none of those five. It sits under `.github/` because that is where
forge tooling and templates look, not because that forge is a tracker here — GitHub is the only tracker.
The five labels above were created on GitHub when the project moved back, alongside GitHub's own
default set (bug, documentation, enhancement, and so on), which the templates also use.
If you need to know which labels exist, ask the API, not that file.

An issue is only `ready-for-agent` when it names the behaviour that is wrong, the file or module it
lives in, and how to tell a fix from a non-fix. "Improve the UI" is `needs-info`, always.
