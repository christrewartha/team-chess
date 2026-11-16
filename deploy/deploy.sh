#!/usr/bin/env bash
# Runs on your dev machine (Git Bash is fine). Deploys whatever is pushed to GitHub to the server.
#   deploy/deploy.sh            # deploy to $DEPLOY_HOST
#   deploy/deploy.sh --force    # restart even if a game is in progress
# Settings come from the environment, or from deploy/config.local (not committed), e.g.
#   DEPLOY_HOST=me@myserver.local
# Optional: DEPLOY_REPO (default: this checkout's origin URL), TEAM_CHESS_PORT (default 3000)
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_HOST="${DEPLOY_HOST:-}"
[ -f deploy/config.local ] && . deploy/config.local

HOST="${ENV_HOST:-${DEPLOY_HOST:-}}" # the environment wins over the config file
HOST="${HOST%$'\r'}" # in case config.local was saved with Windows line endings
if [ -z "$HOST" ]; then
  echo "Set DEPLOY_HOST (user@host of the server), e.g. in deploy/config.local:" >&2
  echo "  echo 'DEPLOY_HOST=me@myserver.local' > deploy/config.local" >&2
  exit 1
fi
REPO="${DEPLOY_REPO:-$(git remote get-url origin)}"
PORT="${TEAM_CHESS_PORT:-3000}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# The server pulls from GitHub, so warn about anything that isn't there yet
if [ -n "$(git status --porcelain)" ]; then
  echo "Warning: you have uncommitted changes; they won't be deployed." >&2
fi
git fetch -q origin 2>/dev/null || true
if [ -n "$(git log origin/main..HEAD --oneline 2>/dev/null)" ]; then
  echo "Warning: local commits not pushed to origin/main; they won't be deployed. (git push)" >&2
fi

echo "Deploying to $HOST ..."
# -t so sudo can prompt the first time (enabling linger)
ssh -t "$HOST" "
  set -e
  [ -d ~/team-chess/.git ] || git clone -q '$REPO' ~/team-chess
  TEAM_CHESS_PORT=$PORT TEAM_CHESS_FORCE=$FORCE bash ~/team-chess/deploy/install.sh
"
