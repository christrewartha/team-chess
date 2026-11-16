'use strict';
// A deliberately weak bot, roughly beginner-club strength (aimed at ~1200, not calibrated).
// It only ever considers moves of its own pieces. For each, it looks at every reply the other
// side could make (a 2-ply search), scores with material plus simple positional tables, adds
// noise, and now and then just plays something random.
const { Chess } = require('chess.js');

const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000;

// piece-square bonuses from White's point of view, a8..h8 first (index = rank8 row first)
const PST = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
};

// static score from `color`'s point of view
function evaluate(chess, color) {
  let s = 0;
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) continue;
      const idx = p.color === 'w' ? r * 8 + f : (7 - r) * 8 + f;
      const v = VALUE[p.type] + PST[p.type][idx];
      s += p.color === color ? v : -v;
    }
  }
  return s;
}

const DEFAULTS = { noise: 45, blunderRate: 0.08, random: Math.random, seen: null };
const posKey = (chess) => chess.fen().split(' ').slice(0, 4).join(' ');

// Pick a move for player `pid`. `owner` maps square -> playerId. `opts.seen` is a Set of earlier
// position keys, used to steer away from repeating (unless it's losing anyway). Returns a verbose move or null.
function chooseMove(fen, owner, pid, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const chess = new Chess(fen);
  const me = chess.turn();
  const mine = chess.moves({ verbose: true }).filter((m) => owner[m.from] === pid);
  if (!mine.length) return null;
  if (o.random() < o.blunderRate) return mine[Math.floor(o.random() * mine.length)];

  let best = null;
  let bestScore = -Infinity;
  for (const m of mine) {
    let score;
    if (m.san.includes('#')) score = MATE;
    else {
      chess.move(m);
      const repeats = o.seen && o.seen.has(posKey(chess));
      const replies = chess.moves({ verbose: true });
      if (!replies.length) score = 0; // stalemate (mate was handled above)
      else {
        let worst = Infinity;
        for (const r of replies) {
          let v;
          if (r.san.includes('#')) v = -MATE;
          else { chess.move(r); v = evaluate(chess, me); chess.undo(); }
          if (v < worst) worst = v;
        }
        score = worst;
      }
      if (repeats) score += score > -150 ? -80 : 40; // a losing bot is happy to repeat
      chess.undo();
    }
    // noise makes it miss things a stronger player wouldn't; mates are never fuzzed away
    if (Math.abs(score) < MATE / 2) score += gauss(o.random) * o.noise;
    if (m.promotion && m.promotion !== 'q') score -= 50; // mostly promote to a queen
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

function gauss(rand) {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const BOT_NAMES = [
  'Blunderbot', 'Deep Blunder', 'Rookie', 'Pawnstar', 'Knightmare', 'Fianchetto', 'Zugzwang', 'Gambit',
  'Woodpusher', 'Patzer', 'Fork Lift', 'Pin Head', 'Skewer', 'Tempo', 'Ray-bot', 'Kibitzer',
  'Hanging Pete', 'Sac Attack', 'Stalemate Sam', 'Mr Fishy', 'Nimzo', 'Tal-ish', 'Smothered', 'Castle Bot',
  'En Passant', 'Queenie', 'Botvinnik', 'Lasker-ish', 'Doubled Pawn', 'Backrank', 'Isolani', 'Greek Gift',
];

module.exports = { chooseMove, evaluate, posKey, BOT_NAMES };
