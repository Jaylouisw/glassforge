# Issue Tracker

Issues and pull requests live on GitHub, in this repository. The project spent a few weeks on a
self-hosted Forgejo instance and came back; that instance still exists as an archive, but nothing is
filed, reviewed or merged there any more.

Numbers did not survive the move. The Forgejo tracker reached #259; this repository's issues
start at #1, so a note citing a Forgejo number points at nothing here - or, once the count passes
it, at a different issue. A migrated issue names its old number in the body (`Migrated from the
Forgejo tracker (glassforge#185)`), and a reference written in the docs uses the GitHub number.

- Repository: `https://github.com/jaylouisw/glassforge`
- Issues: `https://github.com/jaylouisw/glassforge/issues`
- Pull requests: `https://github.com/jaylouisw/glassforge/pulls`
- CLI: `gh` (already authenticated on the development host; no token file to manage)

## Reading

```bash
gh issue list --state open --limit 50
gh issue view 42 --comments
gh pr list --state open --json number,title,headRefName,headRefOid,mergeable,statusCheckRollup
gh pr checks 43
```

`gh pr list --json statusCheckRollup` is the authoritative check state. Do not infer it from
`git ls-remote`: a branch can exist on the remote while its push is still landing, and a pull request
can be green while a ref listing says nothing about it.

## Writing

```bash
# file an issue from a body file (write the body to a file rather than a shell string)
gh issue create --title "..." --body-file /path/to/body.md --label needs-triage

# comment, label, close
gh issue comment 42 --body "..."
gh issue edit 42 --add-label ready-for-agent
gh issue close 42 --reason "not planned"
```

## Pull requests

`main` is protected: force pushes and deletions are refused, and these five checks must pass before a
merge — `Test (Node 18)`, `Test (Node 20)`, `Test (Node 22)`, `Server smoke test`, `Docker build`. That
is a real gate here, not just evidence: GitHub does not append `(push)`/`(pull_request)` to context
names, so the required checks are stable (the Forgejo runner did append them, which is why status
gating had to stay off there). Protection does **not** require a pull request, though:
`required_pull_request_reviews` is `null`, there is no push restriction, and `enforce_admins` is off, so
a direct push to `main` from a collaborator is accepted. PR-only is the project's rule on top of the
gate, not a lock — `AGENTS.md` states the same in one line.

```bash
git push -q origin HEAD:refs/heads/<branch>
gh pr create --base main --head <branch> --title "..." --body-file /path/to/body.md
gh pr merge <n> --squash --delete-branch
```

`scripts/push-branch.sh <branch>` wraps the push, and `node scripts/repo-state.js` prints the whole
queue — main SHA, every open pull request with its checks, every open issue with its labels — in one
call.

What the server actually enforces is one call away, and it is the authority — quote it rather than this
file if the two ever disagree:

```bash
gh api repos/jaylouisw/glassforge/branches/main/protection \
  --jq '{pr: .required_pull_request_reviews, push: .restrictions, admins: .enforce_admins.enabled, force: .allow_force_pushes.enabled, delete: .allow_deletions.enabled}'
# {"admins":false,"delete":false,"force":false,"pr":null,"push":null}
```

## External PRs as a request surface

Off. A pull request opened by someone outside the project is not triaged as an issue request; it is
reviewed on its own terms.
