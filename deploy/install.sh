#!/usr/bin/env bash
# Runs ON the server. Idempotent: first run sets everything up, later runs update and restart.
#   bash ~/team-chess/deploy/install.sh
# Env overrides: TEAM_CHESS_PORT (default 3000), TEAM_CHESS_FORCE=1 (restart even mid-game)
set -euo pipefail

# Everything is inside main() so bash parses the whole script before `git pull` can rewrite it
main() {
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${TEAM_CHESS_PORT:-3000}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/team-chess.service"

say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "node is not installed (or not on PATH). Install Node 18+ first, e.g.:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
  exit 1
fi
say "Using node $("$NODE" -v) at $NODE"

# Don't wipe a game in progress (rooms live in memory)
if [ "${TEAM_CHESS_FORCE:-0}" != "1" ] && systemctl --user is-active --quiet team-chess 2>/dev/null; then
  STATUS="$(curl -fsS "http://localhost:$PORT/status" 2>/dev/null || true)"
  if echo "$STATUS" | grep -q '"playing":[1-9]'; then
    echo "A game is in progress ($STATUS). Restarting would end it." >&2
    echo "Re-run with TEAM_CHESS_FORCE=1 to restart anyway." >&2
    exit 2
  fi
fi

say "Updating code in $APP_DIR"
git -C "$APP_DIR" pull --ff-only

say "Installing dependencies"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)

say "Writing $UNIT"
mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=16v16 team chess server
After=network-online.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$NODE $APP_DIR/server.js
Environment=PORT=$PORT
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

# A user service only survives logout/reboot if lingering is on (needs sudo, once)
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  say "Enabling linger for $USER so the server runs without you logged in (sudo)"
  sudo loginctl enable-linger "$USER"
fi

systemctl --user daemon-reload
systemctl --user enable team-chess >/dev/null 2>&1
systemctl --user restart team-chess

say "Waiting for the server"
for _ in $(seq 1 20); do
  if curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; then
    say "Up: http://$(hostname):$PORT  ($(git -C "$APP_DIR" log -1 --format='%h %s'))"
    exit 0
  fi
  sleep 0.5
done
echo "Server didn't answer on port $PORT. Recent logs:" >&2
journalctl --user -u team-chess -n 30 --no-pager >&2 || true
exit 1
}
main "$@"
