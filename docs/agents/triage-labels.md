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
column. The labels exist on the repo already; creating them again is not part of triage.

An issue is only `ready-for-agent` when it names the behaviour that is wrong, the file or module it
lives in, and how to tell a fix from a non-fix. "Improve the UI" is `needs-info`, always.
