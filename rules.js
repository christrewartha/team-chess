'use strict';
// Pure game logic for 16v16 chess. No networking in here, so it can be tested directly.
const { Chess } = require('chess.js');

const FILES = 'abcdefgh';
const BACK = ['Rook', 'Knight', 'Bishop', 'Queen', 'King', 'Bishop', 'Knight', 'Rook'];
const SIDE_NAME = { w: 'White', b: 'Black' };

const VARIANTS = {
  '16v16': { label: '16 v 16 (one piece each)', perSide: 16 },
  '4v4': { label: '4 v 4 (a cluster of four each)', perSide: 4 },
  '2v2': { label: '2 v 2 (half the board each)', perSide: 2 },
};

// Seats are the "slots" players sit in. Each seat owns a list of starting squares.
function buildSeats(variant) {
  if (!VARIANTS[variant]) throw new Error('Unknown variant: ' + variant);
  const seats = [];
  for (const side of ['w', 'b']) {
    const back = side === 'w' ? '1' : '8';
    const pawn = side === 'w' ? '2' : '7';
    if (variant === '16v16') {
      FILES.split('').forEach((f, i) =>
        seats.push({ id: `${side}-${f}${back}`, side, label: `${BACK[i]} ${f}${back}`, squares: [f + back] }));
      FILES.split('').forEach((f) =>
        seats.push({ id: `${side}-${f}${pawn}`, side, label: `Pawn ${f}${pawn}`, squares: [f + pawn] }));
    } else if (variant === '4v4') {
      const names = ['Rook & Knight (a-b)', 'Bishop & Queen (c-d)', 'King & Bishop (e-f)', 'Knight & Rook (g-h)'];
      for (let k = 0; k < 4; k++) {
        const f1 = FILES[2 * k];
        const f2 = FILES[2 * k + 1];
        seats.push({
          id: `${side}-c${k + 1}`, side, label: names[k] + ' + pawns',
          squares: [f1 + back, f2 + back, f1 + pawn, f2 + pawn],
        });
      }
    } else {
      [['Queenside (a-d)', 'abcd'], ['Kingside (e-h)', 'efgh']].forEach(([label, files], k) => {
        const squares = [];
        for (const f of files) squares.push(f + back);
        for (const f of files) squares.push(f + pawn);
        seats.push({ id: `${side}-h${k + 1}`, side, label, squares });
      });
    }
  }
  return seats;
}

// Can this colour still force a mate? Used to decide timeout wins vs draws.
function hasMatingMaterial(chess, color) {
  let minors = 0;
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.color !== color) continue;
      if (p.type === 'p' || p.type === 'r' || p.type === 'q') return true;
      if (p.type === 'b' || p.type === 'n') minors++;
    }
  }
  return minors >= 2;
}

const PROMO_MS = 5000;
const COLLISION_WINDOW_MS = 3000;

class Game {
  // owner: square -> playerId for every piece on the board.
  constructor({ owner, playerSide, names, baseMs, incMs, now, fen, bots }) {
    this.chess = fen ? new Chess(fen) : new Chess();
    this.owner = { ...owner };
    this.playerSide = { ...playerSide };
    this.names = { ...names };
    this.bots = new Set(bots || []);
    this.baseMs = baseMs;
    this.incMs = incMs;
    this.clock = { w: baseMs, b: baseMs };
    this.startedAt = now;
    this.lastTick = now;
    this.log = [];
    this.collisions = [];
    this.moveCounts = {};
    this.pendingPromo = null;
    this.drawOffer = null; // side that offered
    this.result = null;
    this.over = false;
    this.lastMove = null;
    this.prev = null; // info about the last committed move, for collision detection
    this.events = [];
    this.positions = [this._posKey()]; // for the bots' repetition avoidance
  }

  _posKey() { return this.chess.fen().split(' ').slice(0, 4).join(' '); }

  name(pid) { return this.names[pid] || 'Someone'; }

  kingPlayer(side) {
    for (const row of this.chess.board()) {
      for (const p of row) {
        if (p && p.type === 'k' && p.color === side) return this.owner[p.square];
      }
    }
    return null;
  }

  // The king's player holds resign/draw for the team. If a bot holds the king, any human on that side can.
  speaksForTeam(pid, side) {
    const king = this.kingPlayer(side);
    if (king === pid) return true;
    return this.bots.has(king) && !this.bots.has(pid) && this.playerSide[pid] === side;
  }

  pieceCount(pid) {
    let n = 0;
    for (const sq in this.owner) if (this.owner[sq] === pid) n++;
    return n;
  }

  // squares -> [targets] that this player may move right now
  movableFor(pid) {
    const out = {};
    if (this.over || this.pendingPromo) return out;
    if (this.chess.turn() !== this.playerSide[pid]) return out;
    for (const m of this.chess.moves({ verbose: true })) {
      if (this.owner[m.from] !== pid) continue;
      const list = (out[m.from] = out[m.from] || []);
      if (!list.includes(m.to)) list.push(m.to);
    }
    return out;
  }

  // every square that has a legal move for the side to move (the check spotlight)
  moverSquares() {
    if (this.over) return [];
    return [...new Set(this.chess.moves({ verbose: true }).map((m) => m.from))];
  }

  tick(now) {
    if (this.over) return false;
    const turn = this.chess.turn();
    const el = Math.max(0, now - this.lastTick);
    this.lastTick = Math.max(this.lastTick, now);
    this.clock[turn] -= el;
    if (this.clock[turn] <= 0) {
      this.clock[turn] = 0;
      this._flag(turn);
      return true;
    }
    if (this.pendingPromo && now >= this.pendingPromo.deadline) {
      this._resolvePromo('q', now);
      return true;
    }
    return false;
  }

  attemptMove(pid, from, to, now) {
    if (this.over) return { ok: false, reason: 'over' };
    const side = this.playerSide[pid];
    if (!side) return { ok: false, reason: 'spectator' };
    this.tick(now);
    if (this.over) return { ok: false, reason: 'over' };

    if (this.chess.turn() !== side) {
      this._collisionAfterCommit(pid, side, from, to, now);
      return { ok: false, reason: 'not-your-turn' };
    }
    if (this.pendingPromo) {
      // a teammate is mid-promotion; if this would have been legal, it counts as a collision
      if (this.owner[from] === pid && this.chess.moves({ square: from, verbose: true }).some((m) => m.to === to)) {
        this._recordCollision(pid, side, from, to, now, 0, this.chess);
      }
      return { ok: false, reason: 'busy' };
    }
    if (this.owner[from] !== pid) return { ok: false, reason: 'not-your-piece' };
    const legal = this.chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!legal.length) return { ok: false, reason: 'illegal' };
    if (legal.some((m) => m.promotion)) {
      this.pendingPromo = { pid, from, to, deadline: now + PROMO_MS };
      this.events.push({ type: 'promo', pid, from, to, deadline: this.pendingPromo.deadline });
      return { ok: true, kind: 'promotion-pending' };
    }
    return this._commit(pid, legal[0], now);
  }

  choosePromotion(pid, piece, now) {
    if (this.over || !this.pendingPromo) return { ok: false, reason: 'no-promotion' };
    if (this.pendingPromo.pid !== pid) return { ok: false, reason: 'not-yours' };
    if (!'qrbn'.includes(piece)) return { ok: false, reason: 'bad-piece' };
    this.tick(now);
    if (this.over || !this.pendingPromo) return { ok: false, reason: 'over' };
    return this._resolvePromo(piece, now);
  }

  _resolvePromo(piece, now) {
    const pp = this.pendingPromo;
    this.pendingPromo = null;
    const m = this.chess.moves({ square: pp.from, verbose: true }).find((x) => x.to === pp.to && x.promotion === piece);
    return this._commit(pp.pid, m, now);
  }

  _commit(pid, m, now) {
    const side = this.chess.turn();
    const fenBefore = this.chess.fen();
    const ownerBefore = { ...this.owner };
    const res = this.chess.move({ from: m.from, to: m.to, promotion: m.promotion });

    // ownership follows the piece
    let accomplice = null;
    if (res.flags.includes('e')) delete this.owner[res.to[0] + res.from[1]];
    delete this.owner[res.to];
    this.owner[res.to] = this.owner[res.from];
    delete this.owner[res.from];
    if (res.flags.includes('k') || res.flags.includes('q')) {
      const rank = side === 'w' ? '1' : '8';
      const [rf, rt] = res.flags.includes('k') ? ['h' + rank, 'f' + rank] : ['a' + rank, 'd' + rank];
      accomplice = this.owner[rf];
      this.owner[rt] = this.owner[rf];
      delete this.owner[rf];
    }

    this.clock[side] += this.incMs;
    this.lastTick = Math.max(this.lastTick, now);
    this.moveCounts[pid] = (this.moveCounts[pid] || 0) + 1;
    this.drawOffer = null;
    this.lastMove = { from: res.from, to: res.to, pid, san: res.san, side };
    this.log.push({
      ply: this.log.length + 1, side, san: res.san, pid, name: this.name(pid),
      from: res.from, to: res.to, capture: res.captured || null,
      accomplice: accomplice && accomplice !== pid ? this.name(accomplice) : null,
      t: now - this.startedAt,
    });
    this.prev = { fen: fenBefore, owner: ownerBefore, side, pid, time: now, collided: new Set() };
    this.positions.push(this._posKey());
    this.events.push({ type: 'moved', pid, side, from: res.from, to: res.to, san: res.san, capture: !!res.captured });
    this._checkEnd();
    return { ok: true, kind: 'committed', san: res.san };
  }

  _collisionAfterCommit(pid, side, from, to, now) {
    const pv = this.prev;
    if (!pv || pv.side !== side || pv.pid === pid) return;
    const late = now - pv.time;
    if (late > COLLISION_WINDOW_MS || pv.collided.has(pid) || pv.owner[from] !== pid) return;
    const before = new Chess(pv.fen);
    if (!before.moves({ square: from, verbose: true }).some((m) => m.to === to)) return;
    pv.collided.add(pid);
    this._recordCollision(pid, side, from, to, now, late, before);
  }

  _recordCollision(pid, side, from, to, now, late, chess) {
    const m = chess.moves({ square: from, verbose: true }).find((x) => x.to === to);
    this.collisions.push({ t: now - this.startedAt, pid, name: this.name(pid), side, san: m ? m.san : from + to, lateMs: late });
  }

  _checkEnd() {
    const c = this.chess;
    const mover = c.turn() === 'w' ? 'b' : 'w'; // the side that just moved
    if (c.isCheckmate()) return this._end({ type: 'checkmate', winner: mover, text: `${SIDE_NAME[mover]} wins by checkmate` });
    if (c.isStalemate()) return this._end({ type: 'stalemate', winner: null, text: 'Draw by stalemate' });
    if (c.isInsufficientMaterial()) return this._end({ type: 'insufficient', winner: null, text: 'Draw: insufficient material' });
    if (c.isThreefoldRepetition()) return this._end({ type: 'repetition', winner: null, text: 'Draw by threefold repetition' });
    if (c.isDrawByFiftyMoves()) return this._end({ type: 'fifty', winner: null, text: 'Draw by the fifty-move rule' });
  }

  _flag(side) {
    const other = side === 'w' ? 'b' : 'w';
    if (!hasMatingMaterial(this.chess, other)) {
      return this._end({ type: 'timeout-draw', winner: null, text: `${SIDE_NAME[side]} ran out of time, but ${SIDE_NAME[other]} cannot mate: draw` });
    }
    this._end({ type: 'timeout', winner: other, text: `${SIDE_NAME[other]} wins on time` });
  }

  _end(result) {
    this.result = result;
    this.over = true;
    this.pendingPromo = null;
    this.drawOffer = null;
    this.events.push({ type: 'over', result });
  }

  resign(pid) {
    if (this.over) return { ok: false, reason: 'over' };
    const side = this.playerSide[pid];
    if (!side || !this.speaksForTeam(pid, side)) return { ok: false, reason: 'not-king' };
    const other = side === 'w' ? 'b' : 'w';
    this._end({ type: 'resign', winner: other, text: `${SIDE_NAME[side]} resigns. ${SIDE_NAME[other]} wins` });
    return { ok: true };
  }

  offerDraw(pid) {
    if (this.over) return { ok: false, reason: 'over' };
    const side = this.playerSide[pid];
    if (!side || !this.speaksForTeam(pid, side)) return { ok: false, reason: 'not-king' };
    this.drawOffer = side;
    return { ok: true };
  }

  respondDraw(pid, accept) {
    if (this.over || !this.drawOffer) return { ok: false, reason: 'no-offer' };
    const side = this.playerSide[pid];
    if (!side || side === this.drawOffer || !this.speaksForTeam(pid, side)) return { ok: false, reason: 'not-king' };
    if (accept) this._end({ type: 'agreement', winner: null, text: 'Draw by agreement' });
    else this.drawOffer = null;
    return { ok: true };
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  stats() {
    const bySide = { w: { moves: 0, collisions: 0 }, b: { moves: 0, collisions: 0 } };
    const byPlayer = {};
    for (const pid in this.playerSide) {
      byPlayer[pid] = { name: this.name(pid), side: this.playerSide[pid], moves: this.moveCounts[pid] || 0, collisions: 0 };
      bySide[this.playerSide[pid]].moves += byPlayer[pid].moves;
    }
    for (const c of this.collisions) {
      if (byPlayer[c.pid]) byPlayer[c.pid].collisions++;
      bySide[c.side].collisions++;
    }
    return { bySide, byPlayer };
  }

  snapshot(viewerId) {
    const pieces = {};
    for (const row of this.chess.board()) {
      for (const p of row) if (p) pieces[p.square] = { t: p.type, c: p.color, o: this.owner[p.square] };
    }
    const turn = this.chess.turn();
    let kingSq = null;
    for (const sq in pieces) if (pieces[sq].t === 'k' && pieces[sq].c === turn) kingSq = sq;
    return {
      fen: this.chess.fen(),
      turn,
      pieces,
      check: !this.over && this.chess.isCheck(),
      kingSq,
      clock: { w: Math.round(this.clock.w), b: Math.round(this.clock.b) },
      baseMs: this.baseMs,
      incMs: this.incMs,
      lastMove: this.lastMove,
      log: this.log,
      movable: this.movableFor(viewerId),
      movers: this.moverSquares(),
      pendingPromo: this.pendingPromo,
      drawOffer: this.drawOffer,
      kingPlayer: { w: this.kingPlayer('w'), b: this.kingPlayer('b') },
      speaksForTeam: !!this.playerSide[viewerId] && this.speaksForTeam(viewerId, this.playerSide[viewerId]),
      playerSide: this.playerSide,
      youSide: this.playerSide[viewerId] || null,
      result: this.result,
      stats: this.over ? this.stats() : null,
    };
  }
}

module.exports = { Game, buildSeats, VARIANTS, FILES, BACK, PROMO_MS, COLLISION_WINDOW_MS };
