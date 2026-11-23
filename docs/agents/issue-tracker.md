# Issue Tracker

Issues and pull requests live on the Forgejo instance that hosts this repo. There is no GitHub tracker
for Glassforge; GitHub is not a mirror target either.

- Web: `https://git.jayw.uk/jaylouisw/glassforge`
- API: `http://odin:3000/api/v1/repos/jaylouisw/glassforge`
- Auth: an application token. Never inline it in a document or a commit; the development agents read it
  from `C:/Users/jay/AppData/Local/hermes/secrets/forgejo.token` into `$TOK`.

Every command below runs as written, in one shell, because each one reads `$TOK` from the environment.
Never echo `$TOK`, and never paste a command whose output you print: the token is in the header.

## Reading

```bash
TOK=$(tr -d '\r\n' < C:/Users/jay/AppData/Local/hermes/secrets/forgejo.token)
# open issues, newest first
curl -sS -H "Authorization: token $TOK" \
  'http://odin:3000/api/v1/repos/jaylouisw/glassforge/issues?state=open&type=issues&limit=50'
# one issue, with its body
curl -sS -H "Authorization: token $TOK" \
  'http://odin:3000/api/v1/repos/jaylouisw/glassforge/issues/12'
```

## Writing

```bash
# create an issue from a JSON body file
curl -sS -X POST -H "Authorization: token $TOK" -H 'Content-Type: application/json' \
  --data-binary @issue.json http://odin:3000/api/v1/repos/jaylouisw/glassforge/issues

# comment, label, close
curl -sS -X POST -H "Authorization: token $TOK" -H 'Content-Type: application/json' \
  -d '{"body":"..."}' http://odin:3000/api/v1/repos/jaylouisw/glassforge/issues/12/comments
curl -sS -X POST -H "Authorization: token $TOK" -H 'Content-Type: application/json' \
  -d '{"labels":[7]}' http://odin:3000/api/v1/repos/jaylouisw/glassforge/issues/12/labels
curl -sS -X PATCH -H "Authorization: token $TOK" -H 'Content-Type: application/json' \
  -d '{"state":"closed"}' http://odin:3000/api/v1/repos/jaylouisw/glassforge/issues/12
```

## Pull requests

`main` refuses direct pushes (`enable_push: false`) and does **not** gate on status checks
(`enable_status_check: false`), so a green CI run is something you *read* on the head SHA, never
something the branch protection enforces. Every change is still a branch, a pull request, a CI run you
have actually looked at, then a squash merge:

```bash
# preferred: the helper script builds the token URL without printing the token
bash scripts/push-branch.sh <branch>

# otherwise, the same push by hand
TOK=$(tr -d '\r\n' < C:/Users/jay/AppData/Local/hermes/secrets/forgejo.token)
git push "http://jaylouisw:$TOK@odin:3000/jaylouisw/glassforge.git" HEAD:refs/heads/<branch>

curl -sS -X POST -H "Authorization: token $TOK" -H 'Content-Type: application/json' \
  -d '{"head":"jaylouisw:<branch>","base":"main","title":"...","body":"Closes #12"}' \
  http://odin:3000/api/v1/repos/jaylouisw/glassforge/pulls
```

`scripts/push-branch.sh` is the preferred path but is not on `main` yet, so the "by hand" lines are what
to run until it lands.

Do **not** push with `git -c credential.helper= push -u origin HEAD`. Emptying the credential helper
leaves git with no credentials for `http://odin:3000`, so it asks for a username that nothing can answer
and stops with `could not read Username for 'http://odin:3000': terminal prompts disabled`. The branch
never reaches the remote. The token-in-URL form above authenticates in one step and needs no helper.

The `head` must be owner-qualified or Forgejo answers `bad revision`. Status-check gating is off on
purpose: the runner appends `(push)` / `(pull_request)` to context names, so a fixed required-check
string would freeze every pull request.

## External PRs as a request surface

Off. A pull request opened by someone outside the project is not triaged as an issue request; it is
reviewed on its own terms.
