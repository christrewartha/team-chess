'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game, buildSeats, VARIANTS } = require('./rules');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const ABSENT_MS = 15000;
const LOBBY_PRUNE_MS = 60000;
const ROOM_IDLE_MS = 10 * 60000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function createApp() {
  const rooms = new Map();

  const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const newId = () => crypto.randomBytes(6).toString('hex');
  const hueFor = (room) => (room.nextHue++ * 137.508) % 360 | 0;

  function newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
  }

  function createRoom(variant) {
    const room = {
      code: newCode(), variant, seats: buildSeats(variant), players: new Map(), hostId: null,
      settings: { minutes: 3, increment: 2 }, phase: 'lobby', game: null, nextHue: 0,
      chat: { all: [], w: [], b: [] }, idleSince: Date.now(),
    };
    rooms.set(room.code, room);
    return room;
  }

  function addPlayer(room, name, token) {
    const p = { id: newId(), name: cleanName(name), token, ws: null, connected: false, disconnectedAt: 0, seatId: null, hue: hueFor(room) };
    room.players.set(p.id, p);
    if (!room.hostId) room.hostId = p.id;
    return p;
  }

  const cleanName = (n) => String(n || 'Player').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Player';
  const seatOf = (room, id) => room.seats.find((s) => s.id === id);

  function sys(room, channel, text) {
    pushChat(room, channel, { from: null, text, ts: Date.now(), sys: true });
  }
  function pushChat(room, channel, msg) {
    const list = room.chat[channel];
    list.push(msg);
    if (list.length > 100) list.shift();
  }

  function viewFor(room, p, now) {
    const g = room.game;
    const players = [...room.players.values()].map((q) => {
      const seat = q.seatId ? seatOf(room, q.seatId) : null;
      return {
        id: q.id, name: q.name, hue: q.hue, connected: q.connected,
        absent: !q.connected && now - q.disconnectedAt > ABSENT_MS,
        seatId: q.seatId,
        side: g ? g.playerSide[q.id] || null : seat ? seat.side : null,
        pieces: g ? g.pieceCount(q.id) : null,
      };
    });
    let chat = [];
    if (room.phase === 'playing') {
      const side = g.playerSide[p.id];
      chat = side ? room.chat[side] : [];
    } else chat = room.chat.all;
    const v = {
      t: 'state', serverTime: now, room: room.code, variant: room.variant, phase: room.phase, hostId: room.hostId,
      settings: room.settings, you: p.id, players,
      seats: room.seats.map((s) => ({ id: s.id, side: s.side, label: s.label, squares: s.squares, playerId: s.playerId || null })),
      chat,
    };
    if (g) v.game = g.snapshot(p.id);
    return v;
  }

  function broadcast(room) {
    const now = Date.now();
    if (room.game) pumpGame(room, now);
    for (const p of room.players.values()) send(p.ws, viewFor(room, p, now));
  }

  // drain game events (moves, promotions, results) out to everybody
  function pumpGame(room, now) {
    const g = room.game;
    for (const e of g.drainEvents()) {
      if (e.type === 'moved') {
        const pl = room.players.get(e.pid);
        for (const q of room.players.values()) {
          send(q.ws, { t: 'moved', from: e.from, to: e.to, san: e.san, side: e.side, name: pl ? pl.name : '?', hue: pl ? pl.hue : 0, capture: e.capture });
        }
      }
    }
    if (g.over && room.phase === 'playing') {
      room.phase = 'over';
      sys(room, 'all', g.result.text);
    }
  }

  function startGame(room, p) {
    if (room.phase !== 'lobby') return 'The game has already started';
    if (p.id !== room.hostId) return 'Only the host can start';
    const owner = {};
    const playerSide = {};
    const names = {};
    for (const side of ['w', 'b']) {
      const seats = room.seats.filter((s) => s.side === side);
      const present = [...new Set(seats.filter((s) => s.playerId).map((s) => s.playerId))];
      if (!present.length) return `${side === 'w' ? 'White' : 'Black'} has nobody seated`;
      let rr = 0;
      for (const seat of seats) {
        for (const sq of seat.squares) owner[sq] = seat.playerId || present[rr++ % present.length];
      }
      for (const id of present) { playerSide[id] = side; names[id] = room.players.get(id).name; }
    }
    room.game = new Game({
      owner, playerSide, names,
      baseMs: Math.round(room.settings.minutes * 60000), incMs: Math.round(room.settings.increment * 1000), now: Date.now(),
    });
    room.phase = 'playing';
    room.chat.w = []; room.chat.b = [];
    sys(room, 'w', 'Game on. You are White.');
    sys(room, 'b', 'Game on. You are Black.');
    return null;
  }

  function shuffle(room) {
    for (const s of room.seats) s.playerId = null;
    const ps = [...room.players.values()].filter((q) => q.connected);
    for (const q of room.players.values()) q.seatId = null;
    for (let i = ps.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ps[i], ps[j]] = [ps[j], ps[i]]; }
    const perSide = { w: [], b: [] };
    ps.forEach((q, i) => perSide[i % 2 === 0 ? 'w' : 'b'].push(q));
    for (const side of ['w', 'b']) {
      const seats = room.seats.filter((s) => s.side === side);
      for (let i = seats.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [seats[i], seats[j]] = [seats[j], seats[i]]; }
      perSide[side].slice(0, seats.length).forEach((q, i) => { seats[i].playerId = q.id; q.seatId = seats[i].id; });
    }
  }

  function removePlayer(room, p) {
    if (p.seatId) { const s = seatOf(room, p.seatId); if (s) s.playerId = null; }
    room.players.delete(p.id);
    if (room.hostId === p.id) {
      const next = [...room.players.values()].find((q) => q.connected) || [...room.players.values()][0];
      room.hostId = next ? next.id : null;
    }
  }

  function handle(ws, msg) {
    const now = Date.now();
    if (msg.t === 'create' || msg.t === 'join') {
      let room;
      if (msg.t === 'create') {
        const variant = VARIANTS[msg.variant] ? msg.variant : '2v2';
        room = createRoom(variant);
      } else {
        room = rooms.get(String(msg.room || '').toUpperCase());
        if (!room) return send(ws, { t: 'error', msg: 'No room with that code', fatal: true });
      }
      const token = String(msg.token || '').slice(0, 64) || newId();
      let p = [...room.players.values()].find((q) => q.token === token);
      if (p) { if (msg.name) p.name = cleanName(msg.name); } else p = addPlayer(room, msg.name, token);
      if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch (e) { /* ignore */ } }
      p.ws = ws; p.connected = true; p.disconnectedAt = 0;
      ws.pid = p.id; ws.room = room.code;
      send(ws, { t: 'joined', room: room.code, token, you: p.id });
      return broadcast(room);
    }

    const room = rooms.get(ws.room);
    const p = room && room.players.get(ws.pid);
    if (!p) return send(ws, { t: 'error', msg: 'Not in a room', fatal: true });
    const err = (m) => send(ws, { t: 'error', msg: m });
    const g = room.game;

    switch (msg.t) {
      case 'seat': {
        if (room.phase !== 'lobby') return err('The game has started');
        if (p.seatId) { const old = seatOf(room, p.seatId); if (old) old.playerId = null; p.seatId = null; }
        if (msg.seatId) {
          const s = seatOf(room, msg.seatId);
          if (!s) return err('No such seat');
          if (s.playerId) return err('Seat taken');
          s.playerId = p.id; p.seatId = s.id;
        }
        break;
      }
      case 'leave': {
        if (room.phase === 'playing') return err('You cannot leave during a game');
        removePlayer(room, p);
        ws.pid = null; ws.room = null;
        send(ws, { t: 'left' });
        if (!room.players.size) { rooms.delete(room.code); return; }
        break;
      }
      case 'shuffle':
        if (room.phase !== 'lobby' || p.id !== room.hostId) return err('Only the host can shuffle in the lobby');
        shuffle(room);
        break;
      case 'settings': {
        if (room.phase !== 'lobby' || p.id !== room.hostId) return err('Only the host can change settings');
        const m = Number(msg.minutes), i = Number(msg.increment);
        if (Number.isFinite(m)) room.settings.minutes = Math.min(30, Math.max(0.5, m));
        if (Number.isFinite(i)) room.settings.increment = Math.min(30, Math.max(0, i));
        break;
      }
      case 'start': {
        const e = startGame(room, p);
        if (e) return err(e);
        break;
      }
      case 'rematch':
        if (room.phase !== 'over' || p.id !== room.hostId) return err('Only the host can reset after a game');
        room.phase = 'lobby'; room.game = null;
        break;
      case 'move': {
        if (room.phase !== 'playing') return;
        const r = g.attemptMove(p.id, String(msg.from), String(msg.to), now);
        if (!r.ok && ['not-your-piece', 'illegal'].includes(r.reason)) err(r.reason === 'illegal' ? 'Illegal move' : 'That is not your piece');
        break;
      }
      case 'promote': {
        if (room.phase !== 'playing') return;
        g.choosePromotion(p.id, String(msg.piece), now);
        break;
      }
      case 'resign': case 'drawOffer': case 'drawAccept': case 'drawDecline': {
        if (room.phase !== 'playing') return;
        const r = msg.t === 'resign' ? g.resign(p.id)
          : msg.t === 'drawOffer' ? g.offerDraw(p.id)
            : g.respondDraw(p.id, msg.t === 'drawAccept');
        if (!r.ok) return err(r.reason === 'not-king' ? 'Only the king\'s player can do that' : 'Not possible right now');
        break;
      }
      case 'callFor': {
        if (room.phase !== 'playing' || !g.playerSide[p.id]) return;
        const what = msg.what === 'draw' ? 'a draw' : 'a resignation';
        sys(room, g.playerSide[p.id], `${p.name} calls for ${what}.`);
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;
        let ch = 'all';
        if (room.phase === 'playing') {
          ch = g.playerSide[p.id];
          if (!ch) return err('Spectators cannot chat during a game');
        }
        pushChat(room, ch, { from: p.name, hue: p.hue, text, ts: now });
        break;
      }
      default:
        return;
    }
    broadcast(room);
  }

  // ---- HTTP + WebSocket ----
  const server = http.createServer((req, res) => {
    let url, rel;
    try { url = new URL(req.url, 'http://x'); rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
    if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    if (url.pathname === '/status') {
      // used by the deploy script so it doesn't restart in the middle of someone's game
      const list = [...rooms.values()];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        rooms: list.length,
        playing: list.filter((r) => r.phase === 'playing').length,
        connected: list.reduce((n, r) => n + [...r.players.values()].filter((q) => q.connected).length, 0),
      }));
    }
    if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, data) => {
      if (e) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, maxPayload: 4096 });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || typeof msg.t !== 'string') return;
      try { handle(ws, msg); } catch (e) { console.error('handler error', e); send(ws, { t: 'error', msg: 'Server error' }); }
    });
    ws.on('close', () => {
      const room = rooms.get(ws.room);
      const p = room && room.players.get(ws.pid);
      if (p && p.ws === ws) { p.connected = false; p.disconnectedAt = Date.now(); p.ws = null; broadcast(room); }
    });
    ws.on('error', () => {});
  });

  // game clock + housekeeping
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.phase === 'playing') {
        // tick() reports flags and auto-promotions; otherwise refresh once a second to resync clocks and absent flags
        if (room.game.tick(now) || now % 1000 < 100) broadcast(room);
      }
      if (room.phase === 'lobby') {
        for (const p of [...room.players.values()]) {
          if (!p.connected && now - p.disconnectedAt > LOBBY_PRUNE_MS) { removePlayer(room, p); broadcast(room); }
        }
      }
      const anyone = [...room.players.values()].some((q) => q.connected);
      if (anyone) room.idleSince = now;
      else if (now - room.idleSince > ROOM_IDLE_MS) rooms.delete(code);
    }
  }, 100);
  timer.unref();

  return { server, wss, rooms, close: () => { clearInterval(timer); wss.close(); server.close(); } };
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.server.listen(port, '0.0.0.0', () => {
    console.log(`16v16 chess listening on port ${port}`);
    console.log(`  local:   http://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`  network: http://${ip}:${port}`);
  });
}

module.exports = { createApp };
