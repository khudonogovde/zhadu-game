const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {}; 
const COLORS = ['#ff5c5c', '#4fc3f7', '#ffd54f', '#9ccc65'];
const WIN_SCORE = 5;

// ПАРОЛЬ ДЛЯ ВХОДА В АДМИНКУ (можете поменять на свой)
const ADMIN_PASSWORD = 'admin123'; 

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return rooms[code] ? generateCode() : code;
}

function createRoom(hostId, hostName) {
  const code = generateCode();
  rooms[code] = {
    code: code, hostId: hostId, players: {}, turnOrder: [],
    turnIndex: 0, turnId: null, started: false, winner: null, log: []
  };
  return rooms[code];
}

function addPlayer(room, id, name) {
  if (Object.keys(room.players).length >= 4) return null;
  const used = new Set(Object.values(room.players).map(p => p.colorIdx));
  let ci = 0; while (used.has(ci) && ci < 4) ci++;
  
  room.players[id] = {
    id, name: (name || '').trim().slice(0,12) || 'Игрок',
    colorIdx: ci, bag: { gold: 5, red: 4, green: 4, blue: 4 }, pulled: [], secured: 0
  };
  room.turnOrder.push(id);
  return room.players[id];
}

function updateAdmins() {
  const roomList = Object.keys(rooms).map(code => {
    const r = rooms[code];
    return {
      code: r.code, hostId: r.hostId, started: r.started, winner: r.winner,
      players: Object.values(r.players).map(p => ({ id: p.id, name: p.name, secured: p.secured }))
    };
  });
  io.sockets.sockets.forEach(s => { if (s.isAdmin) s.emit('admin:data', roomList); });
}

function broadcastState(room) {
  if (!room) return;
  const state = {
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, colorIdx: p.colorIdx,
      secured: p.secured, bagCount: p.bag.gold + p.bag.red + p.bag.green + p.bag.blue,
      pulled: p.pulled, isTurn: p.id === room.turnId
    })),
    log: room.log, started: room.started, winner: room.winner,
    code: room.code, hostId: room.hostId
  };
  io.to(room.code).emit('state', state);
  updateAdmins();
}

function nextTurn(room) {
  if (room.winner) return;
  room.turnIndex = (room.turnIndex + 1) % room.turnOrder.length;
  while (!room.players[room.turnOrder[room.turnIndex]]) {
      room.turnIndex = (room.turnIndex + 1) % room.turnOrder.length;
  }
  room.turnId = room.turnOrder[room.turnIndex];
  room.players[room.turnId].pulled = []; 
  room.log.push(`Ход переходит к <b>${room.players[room.turnId].name}</b>.`);
  broadcastState(room);
}

function startGameLogic(room) {
  for (let id in room.players) {
    room.players[id].bag = { gold: 5, red: 4, green: 4, blue: 4 };
    room.players[id].pulled = [];
    room.players[id].secured = 0;
  }
  room.started = true;
  room.winner = null;
  room.log = ['Игра началась!'];
  room.turnIndex = 0;
  room.turnId = room.turnOrder[0];
  broadcastState(room);
}

io.on('connection', (socket) => {
  socket.on('createRoom', (name) => {
    const room = createRoom(socket.id, name);
    addPlayer(room, socket.id, name);
    socket.join(room.code);
    socket.emit('roomJoined', { code: room.code, id: socket.id });
    broadcastState(room);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('errorMsg', 'Комната не найдена');
    if (room.started) return socket.emit('errorMsg', 'Игра уже началась');
    
    const player = addPlayer(room, socket.id, name);
    if (!player) return socket.emit('errorMsg', 'Комната заполнена');
    
    socket.join(code);
    socket.emit('roomJoined', { code: room.code, id: socket.id });
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const roomCode = Array.from(socket.rooms).find(r => r !== socket.id);
    const room = rooms[roomCode];
    if (room && room.hostId === socket.id) startGameLogic(room);
  });

  socket.on('action', (action) => {
    const roomCode = Array.from(socket.rooms).find(r => r !== socket.id);
    const room = rooms[roomCode];
    if (!room || room.turnId !== socket.id || !room.started || room.winner) return;
    const p = room.players[socket.id];

    if (action === 'stop') {
      let goldGained = 0;
      for (let item of p.pulled) {
        if (item === 'gold') goldGained++;
        else p.bag[item]++; 
      }
      p.secured += goldGained;
      p.pulled = [];
      room.log.push(goldGained > 0 ? `✅ ${p.name} забрал ${goldGained} самородков!` : `${p.name} остановился ни с чем.`);

      if (p.secured >= WIN_SCORE) {
        room.winner = p.id;
        room.log.push(`🏆 <b>${p.name} ПОБЕДИЛ!</b>`);
        broadcastState(room);
        return;
      }
      nextTurn(room);
    }

    if (action === 'draw') {
      let total = p.bag.gold + p.bag.red + p.bag.green + p.bag.blue;
      if (total === 0) { room.log.push(`У ${p.name} пустой мешок.`); return nextTurn(room); }

      let rand = Math.random() * total, drawn = null;
      if ((rand -= p.bag.gold) < 0) drawn = 'gold';
      else if ((rand -= p.bag.red) < 0) drawn = 'red';
      else if ((rand -= p.bag.green) < 0) drawn = 'green';
      else drawn = 'blue';

      p.bag[drawn]--; p.pulled.push(drawn);

      const counts = { red:0, green:0, blue:0 };
      for (let item of p.pulled) { if (item !== 'gold') counts[item]++; }

      if (counts.red >= 2 || counts.green >= 2 || counts.blue >= 2) {
        room.log.push(`💥 <b>${p.name} ПРОВАЛИЛСЯ!</b> Вытянул второй ${drawn}.`);
        for (let item of p.pulled) p.bag[item]++;
        p.pulled = [];

        for (let id in room.players) {
          if (id === p.id) continue;
          const other = room.players[id];
          let oTotal = other.bag.gold + other.bag.red + other.bag.green + other.bag.blue;
          if (oTotal === 0) continue;
          let oRand = Math.random() * oTotal, oDrawn = null;
          if ((oRand -= other.bag.gold) < 0) oDrawn = 'gold';
          else if ((oRand -= other.bag.red) < 0) oDrawn = 'red';
          else if ((oRand -= other.bag.green) < 0) oDrawn = 'green';
          else oDrawn = 'blue';
          if (oDrawn !== 'gold') { other.bag[oDrawn]--; p.bag[oDrawn]++; }
        }
        nextTurn(room);
      } else {
        room.log.push(`${p.name} вытянул ${drawn}.`);
        broadcastState(room);
      }
    }
  });

  socket.on('disconnect', () => {
    for (let code in rooms) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        room.log.push(`${room.players[socket.id].name} отключился.`);
        delete room.players[socket.id];
        room.turnOrder = room.turnOrder.filter(id => id !== socket.id);
        if (room.turnId === socket.id && room.turnOrder.length > 0) nextTurn(room);
        else broadcastState(room);
        if (Object.keys(room.players).length === 0) delete rooms[code];
      }
    }
  });

  // --- АДМИНКА ---
  socket.on('admin:login', (pass) => {
    if (pass === ADMIN_PASSWORD) { socket.isAdmin = true; socket.emit('admin:loginSuccess'); updateAdmins(); } 
    else socket.emit('admin:error', 'Неверный пароль');
  });

  socket.on('admin:kick', (playerId) => {
    if (!socket.isAdmin) return;
    const target = io.sockets.sockets.get(playerId);
    if (target) { target.emit('admin:kicked'); target.disconnect(); }
  });

  socket.on('admin:forceStart', (code) => {
    if (!socket.isAdmin) return;
    if (rooms[code] && !rooms[code].started) startGameLogic(rooms[code]);
  });

  socket.on('admin:deleteRoom', (code) => {
    if (!socket.isAdmin) return;
    if (rooms[code]) {
      io.to(code).emit('admin:roomClosed');
      io.in(code).socketsLeave(code);
      delete rooms[code];
      updateAdmins();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на http://localhost:${PORT}`));
