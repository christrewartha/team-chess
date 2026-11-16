'use strict';
const assert = require('assert');
const WebSocket = require('ws');
const { Game, buildSeats, VARIANTS } = require('./rules');
const { createApp } = require('./server');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function game(opts) {
  return new Game({ baseMs: 180000, incMs: 2000, now: 0, names: { A: 'Ann', B: 'Bob', C: 'Cat', D: 'Dan' }, ...opts });
}

// ---- seats ----
test('every variant covers each starting square exactly once', () => {
  for (const v of Object.keys(VARIANTS)) {
    const seats = buildSeats(v);
    assert.strictEqual(seats.length, VARIANTS[v].perSide * 2, v + ' seat count');
    const seen = new Set();
    for (const s of seats) for (const sq of s.squares) {
      assert(!seen.has(sq), 'duplicate ' + sq);
      seen.add(sq);
      const rank = sq[1];
      assert.strictEqual(s.side, ['1', '2'].includes(rank) ? 'w' : 'b');
    }
    assert.strictEqual(seen.size, 32, v + ' covers 32 squares');
  }
});

test('4v4 clusters match the agreed order', () => {
  const seats = buildSeats('4v4').filter((s) => s.side === 'w');
  assert.deepStrictEqual(seats[0].squares, ['a1', 'b1', 'a2', 'b2']); // rook + knight
  assert.deepStrictEqual(seats[1].squares, ['c1', 'd1', 'c2', 'd2']); // bishop + queen
  assert.deepStrictEqual(seats[2].squares, ['e1', 'f1', 'e2', 'f2']); // king + bishop
  assert.deepStrictEqual(seats[3].squares, ['g1', 'h1', 'g2', 'h2']); // knight + rook
});

// ---- rules ----
function twoVTwo() {
  const owner = {};
  const playerSide = { A: 'w', B: 'w', C: 'b', D: 'b' };
  for (const seat of buildSeats('2v2')) {
    const id = { 'w-h1': 'A', 'w-h2': 'B', 'b-h1': 'C', 'b-h2': 'D' }[seat.id];
    for (const sq of seat.squares) owner[sq] = id;
  }
  return game({ owner, playerSide });
}

test('fool\'s mate in 2v2 ends in checkmate, with attribution', () => {
  const g = twoVTwo();
  assert(g.attemptMove('B', 'f2', 'f3', 1000).ok); // kingside white
  assert(g.attemptMove('D', 'e7', 'e5', 2000).ok); // kingside black
  assert(g.attemptMove('B', 'g2', 'g4', 3000).ok);
  const r = g.attemptMove('C', 'd8', 'h4', 4000); // queenside black queen
  assert(r.ok);
  assert(g.over);
  assert.strictEqual(g.result.type, 'checkmate');
  assert.strictEqual(g.result.winner, 'b');
  assert.strictEqual(g.log[3].name, 'Cat');
  assert.strictEqual(g.log[3].san, 'Qh4#');
});

test('you can only move your own piece', () => {
  const g = twoVTwo();
  assert.strictEqual(g.attemptMove('A', 'f2', 'f3', 100).reason, 'not-your-piece');
  assert.strictEqual(g.attemptMove('C', 'e7', 'e5', 100).reason, 'not-your-turn');
  assert.strictEqual(g.attemptMove('A', 'a2', 'a5', 100).reason, 'illegal');
  assert.strictEqual(g.log.length, 0);
});

test('a teammate move that loses the race is logged as a collision', () => {
  const g = twoVTwo();
  assert(g.attemptMove('B', 'f2', 'f3', 1000).ok);
  g.attemptMove('A', 'a2', 'a3', 1200); // legal before, A owns it, same side, 200ms late
  assert.strictEqual(g.collisions.length, 1);
  assert.strictEqual(g.collisions[0].name, 'Ann');
  assert.strictEqual(g.collisions[0].lateMs, 200);
  g.attemptMove('A', 'a2', 'a4', 1300); // same player again: only one collision per move
  assert.strictEqual(g.collisions.length, 1);
  g.attemptMove('B', 'g2', 'g3', 1300); // mover himself is not a collision
  assert.strictEqual(g.collisions.length, 1);
});

test('stale attempts from long after the move are not collisions', () => {
  const g = twoVTwo();
  g.attemptMove('B', 'f2', 'f3', 1000);
  g.attemptMove('A', 'a2', 'a3', 9000);
  assert.strictEqual(g.collisions.length, 0);
});

test('castling is the king player\'s move and the rook changes squares but not owner', () => {
  const g = game({
    fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
    owner: { a1: 'A', e1: 'B', h1: 'C', a8: 'C', e8: 'D', h8: 'D' },
    playerSide: { A: 'w', B: 'w', C: 'w', D: 'b' },
  });
  assert.strictEqual(g.attemptMove('A', 'e1', 'g1', 10).reason, 'not-your-piece'); // A owns a rook only
  const r = g.attemptMove('B', 'e1', 'g1', 20);
  assert(r.ok);
  assert.strictEqual(g.owner.g1, 'B');
  assert.strictEqual(g.owner.f1, 'C'); // rook keeps its owner
  assert.strictEqual(g.owner.h1, undefined);
  assert.strictEqual(g.log[0].accomplice, 'Cat');
});

test('en passant removes the captured pawn\'s ownership', () => {
  const g = game({
    fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1',
    owner: { e5: 'A', d5: 'C', e1: 'A', e8: 'C' },
    playerSide: { A: 'w', C: 'b' },
  });
  assert(g.attemptMove('A', 'e5', 'd6', 10).ok);
  assert.strictEqual(g.owner.d6, 'A');
  assert.strictEqual(g.owner.d5, undefined);
  assert.strictEqual(g.pieceCount('C'), 1);
});

test('promotion: owner chooses, others are locked out, 5s default is a queen', () => {
  const mk = () => game({
    fen: '7k/P7/8/8/8/8/8/K7 w - - 0 1',
    owner: { a7: 'A', a1: 'B', h8: 'C' }, playerSide: { A: 'w', B: 'w', C: 'b' },
  });
  let g = mk();
  assert.strictEqual(g.attemptMove('A', 'a7', 'a8', 100).kind, 'promotion-pending');
  assert.strictEqual(g.attemptMove('B', 'a1', 'a2', 150).reason, 'busy');
  assert.strictEqual(g.collisions.length, 1);
  assert.strictEqual(g.choosePromotion('B', 'n', 200).reason, 'not-yours');
  assert(g.choosePromotion('A', 'n', 300).ok);
  assert.strictEqual(g.chess.get('a8').type, 'n');
  assert.strictEqual(g.owner.a8, 'A');
  assert.strictEqual(g.chess.turn(), 'b');

  g = mk();
  g.attemptMove('A', 'a7', 'a8', 100);
  assert(g.tick(5200)); // deadline 5100
  assert.strictEqual(g.chess.get('a8').type, 'q');
  assert.strictEqual(g.owner.a8, 'A');
});

test('clock: increment is applied, flagging loses unless opponent cannot mate', () => {
  let g = game({ fen: undefined, owner: { e2: 'A', e7: 'C' }, playerSide: { A: 'w', C: 'b' }, baseMs: 10000, incMs: 2000 });
  assert(g.attemptMove('A', 'e2', 'e4', 3000).ok);
  assert.strictEqual(g.clock.w, 10000 - 3000 + 2000);
  g.tick(3000 + 10000);
  assert.strictEqual(g.result.type, 'timeout');
  assert.strictEqual(g.result.winner, 'w');

  g = game({ fen: 'k7/8/8/8/8/8/8/K6R w - - 0 1', owner: { a1: 'A', h1: 'A', a8: 'C' }, playerSide: { A: 'w', C: 'b' }, baseMs: 1000, incMs: 0 });
  g.attemptMove('A', 'h1', 'h2', 100);
  g.tick(5000); // black's clock runs out, but white has a rook: black loses
  assert.strictEqual(g.result.winner, 'w');
  g = game({ fen: 'k7/8/8/8/8/8/8/K7 w - - 0 1', owner: { a1: 'A', a8: 'C' }, playerSide: { A: 'w', C: 'b' }, baseMs: 1000, incMs: 0 });
  g.tick(2000);
  assert.strictEqual(g.result.type, 'timeout-draw'); // only kings left
});

test('resign and draw are the king player\'s buttons', () => {
  const g = twoVTwo();
  assert.strictEqual(g.kingPlayer('w'), 'B');
  assert.strictEqual(g.resign('A').reason, 'not-king');
  assert(g.offerDraw('B').ok);
  assert.strictEqual(g.respondDraw('A', true).reason, 'not-king');
  assert.strictEqual(g.respondDraw('B', true).reason, 'not-king'); // cannot accept your own offer
  assert(g.respondDraw('D', false).ok);
  assert.strictEqual(g.drawOffer, null);
  assert(g.offerDraw('B').ok);
  assert(g.respondDraw('D', true).ok);
  assert.strictEqual(g.result.type, 'agreement');
  const g2 = twoVTwo();
  assert(g2.resign('D').ok);
  assert.strictEqual(g2.result.winner, 'w');
});

test('check locks out players who cannot resolve it', () => {
  const g = game({
    fen: '4k3/8/8/8/8/8/3PP3/r3K3 w - - 0 1',
    owner: { d2: 'A', e2: 'A', e1: 'B', a1: 'C', e8: 'C' }, playerSide: { A: 'w', B: 'w', C: 'b' },
  });
  assert(g.chess.isCheck());
  assert.deepStrictEqual(g.movableFor('A'), {}); // pawns cannot block a rank-1 check
  assert(g.movableFor('B').e1.length > 0);
  assert.deepStrictEqual(g.moverSquares(), ['e1']);
});

// ---- full websocket flow ----
function client(url) {
  const ws = new WebSocket(url);
  const c = { ws, states: [], events: [], errors: [] };
  c.ready = new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'state') c.state = m;
    else if (m.t === 'moved') c.events.push(m);
    else if (m.t === 'error') c.errors.push(m);
    else if (m.t === 'joined') c.joined = m;
    c.waiters = (c.waiters || []).filter((w) => !w(m));
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.until = (pred, ms = 3000) => new Promise((res, rej) => {
    const check = () => pred(c);
    if (check()) return res();
    const to = setTimeout(() => rej(new Error('timeout waiting; last state phase=' + (c.state && c.state.phase))), ms);
    (c.waiters = c.waiters || []).push(() => { if (check()) { clearTimeout(to); res(); return true; } return false; });
  });
  return c;
}

test('websocket game: lobby, seats, start, moves, attribution, chat, resign', async () => {
  const app = createApp();
  await new Promise((r) => app.server.listen(0, r));
  const url = 'ws://127.0.0.1:' + app.server.address().port;
  try {
    const a = client(url), b = client(url);
    await Promise.all([a.ready, b.ready]);
    a.send({ t: 'create', name: 'Ann', token: 'ta', variant: '2v2' });
    await a.until((c) => c.state && c.joined);
    const code = a.joined.room;
    b.send({ t: 'join', room: code.toLowerCase(), name: 'Bob', token: 'tb' });
    await b.until((c) => c.state && c.state.players.length === 2);

    // can't start with an empty side
    a.send({ t: 'seat', seatId: 'w-h1' });
    a.send({ t: 'start' });
    await a.until((c) => c.errors.length === 1);
    b.send({ t: 'seat', seatId: 'w-h1' });
    await b.until((c) => c.errors.length === 1); // seat taken
    b.send({ t: 'seat', seatId: 'b-h2' });
    await a.until((c) => c.state.seats.find((s) => s.id === 'b-h2').playerId);
    a.send({ t: 'settings', minutes: 5, increment: 3 });
    b.send({ t: 'chat', text: 'hello lobby' });
    await a.until((c) => c.state.chat.length === 1 && c.state.settings.minutes === 5);
    a.send({ t: 'start' });
    await Promise.all([a, b].map((c) => c.until(() => c.state.phase === 'playing')));

    // short-handed: Ann owns every white piece, Bob every black one
    assert.strictEqual(a.state.players.find((p) => p.name === 'Ann').pieces, 16);
    assert.strictEqual(a.state.game.clock.w, 300000);
    assert.strictEqual(a.state.game.incMs, 3000);
    assert(a.state.game.movable.e2.includes('e4'));
    assert.deepStrictEqual(b.state.game.movable, {}); // not black's turn

    // out-of-turn attempts are ignored silently, wrong-piece attempts get an error
    b.send({ t: 'move', from: 'e7', to: 'e5' });
    a.send({ t: 'move', from: 'e7', to: 'e5' });
    await a.until((c) => c.errors.length === 2);
    assert.strictEqual(a.state.game.log.length, 0);

    a.send({ t: 'move', from: 'e2', to: 'e4' });
    await Promise.all([a, b].map((c) => c.until(() => c.events.length === 1 && c.state.game.log.length === 1)));
    assert.strictEqual(b.events[0].name, 'Ann');
    assert.strictEqual(b.events[0].san, 'e4');
    assert.strictEqual(b.state.game.log[0].name, 'Ann');
    assert(b.state.game.movable.e7.includes('e5'));

    // team chat stays on the team
    a.send({ t: 'chat', text: 'secret white plan' });
    await a.until((c) => c.state.chat.some((m) => m.text === 'secret white plan'));
    b.send({ t: 'chat', text: 'secret black plan' });
    await b.until((c) => c.state.chat.some((m) => m.text === 'secret black plan'));
    assert(!b.state.chat.some((m) => m.text === 'secret white plan'));

    b.send({ t: 'move', from: 'e7', to: 'e5' });
    await a.until((c) => c.state.game.log.length === 2);
    assert.strictEqual(a.state.game.turn, 'w');

    // only the king's player can resign; here that is Ann for White
    b.send({ t: 'resign' });
    await b.until((c) => c.state.phase === 'over'); // Bob owns the black king
    assert.strictEqual(a.state.game.result.winner, 'w');
    assert(a.state.game.stats.byPlayer);
    b.send({ t: 'rematch' });
    await b.until((c) => c.errors.length >= 2); // not the host
    a.send({ t: 'rematch' });
    await a.until((c) => c.state.phase === 'lobby');
  } catch (e) {
    app.close();
    throw e;
  }
  app.close();
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log('  ok  ' + name);
    } catch (e) {
      console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e));
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  setTimeout(() => process.exit(process.exitCode || 0), 50);
})();
