const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, '.')));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 25000, pingTimeout: 20000 });

const players = new Map();

io.on('connection', (socket) => {
  const id = socket.id;
  const p = { x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0 };
  players.set(id, p);
  socket.emit('init', { id, players: [...players.entries()].map(([k, v]) => ({ id: k, ...v })) });
  socket.broadcast.emit('player-join', { id, ...p });

  socket.on('state', (s) => {
    const pl = players.get(id);
    if (!pl) return;
    pl.x = Number(s.x) || 0;
    pl.y = Number(s.y) || 0;
    pl.z = Number(s.z) || 0;
    pl.yaw = Number(s.yaw) || 0;
    pl.pitch = Number(s.pitch) || 0;
    socket.broadcast.emit('player-move', { id, x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw, pitch: pl.pitch });
  });

  socket.on('shoot', (d) => {
    socket.broadcast.emit('player-shoot', {
      id,
      x: Number(d.x) || 0,
      y: Number(d.y) || 0,
      z: Number(d.z) || 0,
      dx: Number(d.dx) || 0,
      dy: Number(d.dy) || 0,
      dz: Number(d.dz) || 0
    });
  });

  socket.on('disconnect', () => {
    players.delete(id);
    io.emit('player-left', id);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('cs2-web-shooter server listening on', port);
});
