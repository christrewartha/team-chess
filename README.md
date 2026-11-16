# 16v16 Chess (prototype v0.1)

Team chess where every player controls their own piece(s), and the first legal move on your team's turn is the team's move. Rules: see [16v16 Chess Ruleset.md](16v16%20Chess%20Ruleset.md) for the design, or [public/rules.html](public/rules.html) (the in-game "How to play" page) for the player version.

## Run it

```
npm install
npm start            # port 3000; set PORT=8080 to change
```

The server prints a `network:` address on startup. Open that on any device on your LAN, enter a name, create a room, and share the 4-letter code or the invite link.

To play from outside the house, put it behind a reverse proxy with TLS (Caddy: `caddy reverse-proxy --from chess.example.com --to localhost:3000`), or use a tunnel/VPN (Tailscale, Cloudflare Tunnel). The client switches to `wss://` automatically on HTTPS. WebSockets must be allowed through the proxy.

## Deploying to a Linux server

The deploy script installs the game on a Linux machine you can SSH into and runs it as a systemd user service called `team-chess`. The server pulls the code from your GitHub repo, so it deploys whatever is pushed to `main`.

Needs on the server: Node 18+, git, curl, and SSH access from your dev machine (ideally with a key, so you aren't typing a password every time).

Tell the script where the server is, once, in `deploy/config.local` (it's gitignored):

```
DEPLOY_HOST=you@yourserver.local
```

Then:

```
git push
npm run deploy               # clone or pull on the server, npm ci, restart, health check
npm run deploy -- --force    # restart even if a game is in progress
```

`npm run deploy` runs `deploy/deploy.sh` and works from PowerShell; it finds Git Bash itself. You can also run `deploy/deploy.sh` directly from bash, or set `DEPLOY_HOST` in the environment instead of the config file. `TEAM_CHESS_PORT` changes the port (default 3000).

The first run clones to `~/team-chess` and asks for your sudo password once, to enable lingering so the service runs without you logged in and starts at boot. The deploy refuses to restart while a game is being played, because rooms live in memory and a restart ends them.

On the server: `systemctl --user status team-chess`, logs with `journalctl --user -u team-chess -f`. `/status` shows rooms, games in progress and connected players.

## Testing it alone

Open two or more browser tabs (or a phone plus a laptop). Each tab is its own player, and refreshing a tab rejoins the same seat. In the lobby, put one player on each side and press Start. Empty seats' pieces are shared out among the players seated on that side, so 2 players can play any variant.

## Variants

| Variant | Seats per side | Who controls what |
| --- | --- | --- |
| 16v16 | 16 | one piece each |
| 4v4 | 4 | two pieces plus the two pawns in front of them |
| 2v2 | 2 | queenside (a-d files) and kingside (e-h files) |

## Files

- `rules.js`: all game logic (ownership, arbitration, clocks, collisions, promotion). No networking.
- `server.js`: HTTP + WebSocket server, rooms, seats, chat.
- `public/index.html`: the whole client.
- `test.js`: `npm test` runs the rules tests and a full websocket game.

## Not built yet

Bots, the Ray Award / blame replay (needs an engine), accounts, persistence. Rooms live in memory and vanish on restart.
