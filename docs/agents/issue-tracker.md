# Issue Tracker

Issues and pull requests live on the Forgejo instance that hosts this repo. There is no GitHub tracker
for Glassforge; GitHub is not a mirror target either.

- Web: `https://git.jayw.uk/jaylouisw/glassforge`
- API: `http://odin:3000/api/v1/repos/jaylouisw/glassforge`
- Auth: an application token. Never inline it in a document or a commit; the development agents read it
  from `C:/Users/jay/AppData/Local/hermes/secrets/forgejo.token`.

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

`main` refuses direct pushes (`enable_push: false`). Every change is a branch, a pull request, a green
CI run on the head SHA, then a squash merge:

```bash
git -c credential.helper= push -u origin HEAD
curl -sS -X POST -H "Authorization: token $TOK" -H 'Content-Type: application/json' \
  -d '{"head":"jaylouisw:<branch>","base":"main","title":"...","body":"Closes #12"}' \
  http://odin:3000/api/v1/repos/jaylouisw/glassforge/pulls
```

The `head` must be owner-qualified or Forgejo answers `bad revision`. Status-check gating is off on
purpose: the runner appends `(push)` / `(pull_request)` to context names, so a fixed required-check
string would freeze every pull request.

## External PRs as a request surface

Off. A pull request opened by someone outside the project is not triaged as an issue request; it is
reviewed on its own terms.
