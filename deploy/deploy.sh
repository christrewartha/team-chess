#!/usr/bin/env bash
# Runs on your dev machine (Git Bash is fine). Deploys whatever is pushed to GitHub to the server.
#   deploy/deploy.sh            # deploy to chris@scaramanga
#   deploy/deploy.sh --force    # restart even if a game is in progress
# Env overrides: DEPLOY_HOST (default chris@scaramanga), TEAM_CHESS_PORT (default 3000)
set -euo pipefail

HOST="${DEPLOY_HOST:-chris@scaramanga}"
REPO="https://github.com/christrewartha/team-chess.git"
PORT="${TEAM_CHESS_PORT:-3000}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# The server pulls from GitHub, so warn about anything that isn't there yet
cd "$(dirname "$0")/.."
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
  [ -d ~/team-chess/.git ] || git clone -q $REPO ~/team-chess
  TEAM_CHESS_PORT=$PORT TEAM_CHESS_FORCE=$FORCE bash ~/team-chess/deploy/install.sh
"
