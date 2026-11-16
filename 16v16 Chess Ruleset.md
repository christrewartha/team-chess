# 16v16 Chess: Ruleset v0.1

Nov 16, 2026 · @Chris Trewartha

## Concept

16v16 chess is team chess at speed: each side's 16 pieces are played by 16 different people, and you may only move your own piece. Whoever moves first on their team's turn commits the whole team, so every move has a name attached.

The design goal is the "WHAT DID YOU MOVE, RAY?" moment: a fast, loud, shared mistake with an obvious culprit. Short clocks, instant commits, visible attribution and no take-backs all serve that.

Standard FIDE rules apply to anything this document doesn't cover.

## Players and teams

The full game needs 32 players, one per piece. The same ruleset scales down by giving each player several pieces, marked with a coloured base so everyone can see who owns what.

| Variant | Players per side | Total players | Who controls what |
| --- | --- | --- | --- |
| 16 v 16 | 16 | 32 | One piece each. The main mode, though the lobby will rarely fill, so empty seats' pieces are shared among the players present for now |
| 4 v 4 | 4 | 8 | A cluster of four each: two pieces and the two pawns in front of them |
| 2 v 2 | 2 | 4 | The board is split down the middle: one player takes the kingside, the other the queenside |

**Assigning pieces.** In 4 v 4, each player takes a neighbouring pair of pieces plus the two pawns in front of them. In 2 v 2, each player takes a half of the board.

- **4 v 4, cluster 1:** rook and knight from the queenside, plus the a- and b-pawns.
- **4 v 4, cluster 2:** bishop and queen, plus the c- and d-pawns.
- **4 v 4, cluster 3:** king and bishop, plus the e- and f-pawns.
- **4 v 4, cluster 4:** knight and rook from the kingside, plus the g- and h-pawns.
- **2 v 2, queenside player:** queen, rook, knight and bishop from the a to d files, plus the a- to d-pawns.
- **2 v 2, kingside player:** king, rook, knight and bishop from the e to h files, plus the e- to h-pawns.

**Multi-piece players** may move any one of their own pieces on a turn. Moving a teammate's piece is never allowed.

**Ownership is permanent.** A promoted pawn stays with the pawn's player. Seats are drawn at random at game start; a lobby can allow players to swap by mutual agreement before the clock starts.

**Short-handed games.** With fewer players than seats, the pieces of empty seats are shared out round-robin among the players present on that side. Any variant can therefore start with two or more players, which replaces bots for now.

## Turn flow and move arbitration

The first legal move from any eligible player on the side to move is the team's move. The server decides what "first" means, so there is no client-side race.

1. The side to move's clock runs. Every player on that side may pick up one of their own pieces.
2. A player drags a piece to a legal square and releases. The server receives the move and checks it against the current position.
3. The first valid move the server receives is committed instantly. The turn passes, the clock switches, and the mover is stamped on the move.
4. Any other attempt that arrives afterwards is rejected as a **collision** and logged (see Modes and anti-collusion).

**Simultaneous arrivals.** If two moves land within the same server tick (about 20 ms), the winner is picked at random. Order is never decided by client timestamps.

**No take-backs.** A committed move is final. That is the point.

**Misclicks.** Pressing Esc, or dropping a piece back on its own square, cancels before release. After release, there is nothing to cancel. Captures show a brief highlight on the target square while dragging, so the cost is visible before it's paid.

**Ineligible pieces.** A piece with no legal moves, or one that can't help in check, is greyed out and can't be picked up. Its player sees "no legal moves" so they don't think the game is broken.

## Check, checkmate and stalemate

When the king is in check, only players holding a piece that can resolve it may move. Everyone else is locked out, and the team's fate rests on a few people.

- **Check spotlight.** The board highlights every piece with a resolving move, so the team can see exactly who is on the hook.
- **Sole saviour.** If only one player's pieces can resolve the check, that player is the only one who can act. The clock keeps running, and it is entirely on them.
- **Checkmate.** No piece on the side has a legal move while the king is in check. The side loses.
- **Stalemate.** No piece has a legal move and the king is not in check. The game is drawn, as in standard chess.

**Other draws.** Threefold repetition, the fifty-move rule and insufficient material apply as normal.

**Resign and draw offers.** The king's player holds the resign and draw buttons for the team, because the hot seat should carry the responsibility. A teammate can "call for" a resignation or draw, and the king's player decides.

## Special moves

Each special move belongs to the player whose piece makes it, which keeps blame clean.

- **Castling** is a king move. The king's player decides when it happens, and the rook goes along without a say. The rook's player is credited as an accomplice in the move log, but has no veto.
- **En passant** is a move by the capturing pawn's player, like any other capture.
- **Promotion** is the pawn's player's moment. When a pawn reaches the last rank, that player has 5 seconds to choose a queen, rook, bishop or knight, and the team's clock keeps running. If they don't choose, the pawn promotes to a queen. The new piece stays with the same player.

## Clocks, timeouts and absent players

The default clock is 3 minutes per side with a 2-second increment per move. The increment stops one slow position from ending the game on the clock, and the lobby can set it to zero for pure blitz.

| Setting | Default | Notes |
| --- | --- | --- |
| Base time per side | 3:00 | Lobby-configurable, 1:00 to 10:00 |
| Increment per move | 2 s | Zero allowed |
| Promotion choice | 5 s | Runs inside the team clock |
| Disconnect grace | 15 s | Before a seat counts as absent |
| Bot move delay | 8 s | How long a bot waits before acting |

**Flagging.** A side whose clock reaches zero loses, unless the opponent has insufficient material to mate.

**Absent players.** A player who disconnects for 15 seconds is marked absent. Their pieces still count, and the team can still be blocked by them (see Check), which is part of the drama.

**Bot fill-in.** Deferred while the concept is tested: there are no bots in v0.1. Empty or absent seats can be played by a bot. A bot moves one of its own pieces only if nobody else on the team has moved within 8 seconds, or if its piece is the only one that can resolve a check. It picks the best move among its own piece's options, so it never outplays the humans, and it never plays a move outside its piece.

## Attribution and blame

Every move is signed. Nobody gets to say "I didn't touch it".

- **Piece labels.** Every piece carries its player's name or avatar permanently, not just on hover.
- **Move flash.** When a move lands, the mover's name flashes over the piece and a sound plays, so the whole team sees who did it at the same moment.
- **Move log.** A running log credits each move: "Ray: Bf1-c4". Captures lost and gained are tagged.
- **Blame replay.** After the game, an engine finds the biggest evaluation swings and attributes them: the **Ray Award** goes to the player who made the worst move, and an MVP goes to the best. Both are shown with the position before and after. This is parked until an engine is wired in.

**Blame level** is a lobby setting:

| Level | What shows | Suggested for |
| --- | --- | --- |
| Full | Real names on everything, full blame replay | Private games with friends |
| Icons | Avatars or emoji badges instead of names | Mixed groups |
| Off | No names on moves, no awards | Public lobbies with strangers |

The default is Full for private rooms and Icons for public ones.

## Captured players

A player whose last piece is captured becomes a **Ghost**: out of the game, but still part of the team's noise.

- **Ghosts can't move.** They hold no pieces and never affect arbitration.
- **Ghosts can chat.** That is all they can do. The clock is too tight for advice to land, so there are no board arrows or pings.
- **No respawn.** Once captured, a player stays a ghost for the rest of the game.

The endgame therefore gets quieter on the board and louder in the chat, with fewer players able to act and more people watching them do it.

## Modes and anti-collusion

Two modes control how much teammates can see of each other's intent. Party is the default.

|  | Party | Stealth |
| --- | --- | --- |
| Hover and pick-up visible to team | Yes | No |
| Team text chat | Yes | Preset pings only |
| Ghost chat | Team channel | Team channel (cheating isn't a concern while testing) |
| Intended feel | Loud, social, finger-pointing | Tense, silent, committed |

Stealth hides intent entirely: the first you know of a move is when it lands. It is the purest version of the Ray moment.

**Voice chat can't be stopped,** so the game doesn't try. Party mode treats a coordinating team as a feature. For stricter play, the server logs enough to see whether a team is talking outside the game.

**Collision log.** Every legal move attempt that loses the race to a teammate is recorded as a collision, with its timing. An uncoordinated team produces plenty of them. A team talking off-platform produces almost none, and its move times cluster tightly.

The log supports a post-game stat, "Collision rate", and a flag for moderators on rooms where it is unusually low across several games. It is a signal, not proof, and it never ends a game on its own.

## Build notes and open questions

A server-authoritative web app is enough for the home server, and a phone browser can be a client. Proposed shape:

- **Server:** Node with WebSockets. One room object per game holds the position, clocks, seat map and move log. The server validates every move and orders arrivals.
- **Rules engine:** an existing chess library (e.g. chess.js) for legality, check and draw detection, wrapped with the piece-ownership and eligibility checks above.
- **Client:** a plain web page with drag-and-drop, piece labels, the move flash and the move log. No install for players.
- **Bots and blame replay:** Stockfish can restrict its search to a list of moves, which fits "best move for this one piece" and the post-game evaluation swings.
- **Access:** a reverse proxy with TLS, plus either a tunnel or a VPN for friends outside the house. Rooms are joined by a short code.
- **Build order:** rooms and seats, then arbitration and the move log, then clocks, then Stealth/Party, then bots and the blame replay.

**Open questions**

- [ ] Ray Award and blame replay: revisit once an engine is available to compare moves against.
