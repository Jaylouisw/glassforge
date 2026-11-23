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
column. All five exist on the Forgejo repository at `git.jayw.uk/jaylouisw/glassforge` — created
2026-11-23 through the API — so applying one is a `POST .../issues/<n>/labels`, not a creation step.

They are **not** declared in `.github/labels.yml`: that file lists the five workflow labels (`bug`,
`enhancement`, `parts`, `docs`, `ci`) and none of the triage five. Do not add them there, and do not treat
that file as the source of truth for triage — the repository is.

An issue is only `ready-for-agent` when it names the behaviour that is wrong, the file or module it
lives in, and how to tell a fix from a non-fix. "Improve the UI" is `needs-info`, always.
