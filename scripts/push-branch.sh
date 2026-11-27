#!/usr/bin/env bash
# Push the current HEAD to a branch on GitHub (the `origin` remote) and print the compare URL.
#
# Why this script exists: a bare `git -c credential.helper= push` clears the credential store and dies
# with "could not read Username". That happened twice in one session - once to a human-driven run, once
# to a worker lane that then lost its work tail. One command, in one place.
#
# The repository lives on GitHub now, so this pushes to `origin` and lets `gh`/git's credential helper
# supply the credentials. No token is read, embedded or printed by this file - there is nothing to leak
# and nothing to redact.
#
#   scripts/push-branch.sh                 # push HEAD to the current branch name
#   scripts/push-branch.sh feat/my-branch  # push HEAD to an explicit name
#
# Env overrides: GLASSFORGE_REMOTE (default: origin), GLASSFORGE_PUBLIC (default: the GitHub web root).
set -euo pipefail

REMOTE="${GLASSFORGE_REMOTE:-origin}"
PUBLIC="${GLASSFORGE_PUBLIC:-https://github.com/jaylouisw/glassforge}"

die() {
  echo "push-branch: $*" >&2
  exit 2
}

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
BRANCH="${BRANCH#refs/heads/}"

case "$BRANCH" in
  ''|HEAD|head|main|master|refs/heads/main)
    echo "push-branch: refusing to push '$BRANCH' - name a feature branch (main is PR-only)" >&2
    exit 2
    ;;
esac

# The retired Forgejo remote is still configured as `forgejo` and is read-only from here, so pushing at
# it is always a mistake. Catch the misconfigured remote before git turns it into a confusing prompt.
URL=$(git remote get-url "$REMOTE" 2>/dev/null) || die "no such remote '$REMOTE' (set GLASSFORGE_REMOTE)"
case "$URL" in
  *odin:3000*|*git.jayw.uk*)
    die "remote '$REMOTE' points at the retired Forgejo ($URL); it is read-only - use origin (GitHub)"
    ;;
esac

SHA=$(git rev-parse --short HEAD)

# Loud failure path: git echoes the remote URL and the server's reason on failure, so print the whole
# thing in a block nobody can scroll past, plus what to check. The destination is always named
# explicitly (HEAD:refs/heads/<branch>) so a stray upstream setting cannot redirect the push.
if ! OUTPUT=$(git push --porcelain "$REMOTE" "HEAD:refs/heads/$BRANCH" 2>&1); then
  {
    echo "########################################################################"
    echo "# PUSH FAILED: $SHA -> $REMOTE refs/heads/$BRANCH"
    echo "########################################################################"
    printf '%s\n' "$OUTPUT"
    echo "-----------------------------------------------------------------------"
    echo "# Nothing was pushed. Check the remote and the credentials, then retry:"
    echo "#   git remote -v                     # origin must be github.com/jaylouisw/glassforge"
    echo "#   gh auth status                    # gh holds the credential; no token file is involved"
    echo "#   bash scripts/push-branch.sh $BRANCH"
    echo "########################################################################"
  } >&2
  exit 1
fi

echo "pushed $SHA to $REMOTE/$BRANCH"
echo "open a pull request: $PUBLIC/compare/main...$BRANCH"
