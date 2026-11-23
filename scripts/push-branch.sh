#!/usr/bin/env bash
# Push the current HEAD to a branch on the Glassforge forge, and print the compare URL.
#
# Why this script exists: `git -c credential.helper= push` clears the credential store and dies with
# "could not read Username for 'http://odin:3000'". That happened twice in one session - once to a
# human-driven run, once to a worker lane that then lost its work tail. One command, in one place.
#
#   scripts/push-branch.sh                 # push HEAD to the current branch name
#   scripts/push-branch.sh feat/my-branch  # push HEAD to an explicit name
#
# Env overrides: GLASSFORGE_TOKEN_FILE, GLASSFORGE_REMOTE, GLASSFORGE_PUBLIC.
set -euo pipefail

TOKEN_FILE="${GLASSFORGE_TOKEN_FILE:-C:/Users/jay/AppData/Local/hermes/secrets/forgejo.token}"
REMOTE="${GLASSFORGE_REMOTE:-http://odin:3000/jaylouisw/glassforge.git}"
PUBLIC="${GLASSFORGE_PUBLIC:-https://git.jayw.uk/jaylouisw/glassforge}"

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
case "$BRANCH" in
  HEAD|main)
    echo "refusing to push '$BRANCH': name a feature branch (the forge refuses direct pushes to main anyway)" >&2
    exit 2
    ;;
esac

# Git-bash does not always accept a `C:/...` path in a test, so normalise it once. This bit the first
# version of this script: the token file existed and the check still said it did not.
resolve_path() {
  local candidate="$1"
  if [ -f "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  if command -v cygpath >/dev/null 2>&1; then
    local unix
    unix=$(cygpath -u "$candidate" 2>/dev/null || true)
    if [ -n "$unix" ] && [ -f "$unix" ]; then printf '%s' "$unix"; return 0; fi
  fi
  case "$candidate" in
    [A-Za-z]:/*)
      local drive rest
      drive=$(printf '%s' "$candidate" | cut -c1 | tr 'A-Z' 'a-z')
      rest=$(printf '%s' "$candidate" | cut -c4-)
      printf '/%s/%s' "$drive" "$rest"
      ;;
    *) printf '%s' "$candidate" ;;
  esac
}

TOKEN_PATH=$(resolve_path "$TOKEN_FILE")
if [ ! -f "$TOKEN_PATH" ]; then
  echo "no token file at $TOKEN_FILE (set GLASSFORGE_TOKEN_FILE)" >&2
  exit 2
fi

TOKEN=$(tr -d '\r\n' < "$TOKEN_PATH")
if [ -z "$TOKEN" ]; then
  echo "token file $TOKEN_FILE is empty" >&2
  exit 2
fi

AUTHED=$(printf '%s' "$REMOTE" | sed -E "s#^(https?://)#\\1jaylouisw:${TOKEN}@#")

# git echoes the remote URL on failure, token and all, so capture and redact before showing anything.
if ! OUTPUT=$(git push -q "$AUTHED" "HEAD:refs/heads/$BRANCH" 2>&1); then
  printf '%s\n' "$OUTPUT" | sed "s/$TOKEN/<token>/g" >&2
  exit 1
fi

echo "pushed $(git rev-parse --short HEAD) to $BRANCH"
echo "open a pull request: $PUBLIC/compare/main...$BRANCH"
