const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, '.')));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 25000, pingTimeout: 20000 });

const players = new Map();
let codeSeq = 2;
const inviteCooldown = new Map();

io.on('connection', (socket) => {
  const id = socket.id;
  const p = { x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0, grounded: 1, code: codeSeq++ };
  players.set(id, p);
  socket.emit('init', { id, players: [...players.entries()].map(([k, v]) => ({ id: k, ...v })) });
  socket.broadcast.emit('player-join', { id, ...p });
  socket.emit('you_id', { id: p.code });

  socket.on('state', (s) => {
    const pl = players.get(id);
    if (!pl) return;
    pl.x = Number(s.x) || 0;
    pl.y = Number(s.y) || 0;
    pl.z = Number(s.z) || 0;
    pl.yaw = Number(s.yaw) || 0;
    pl.pitch = Number(s.pitch) || 0;
    pl.grounded = s.grounded ? 1 : 0;
    socket.broadcast.emit('player-move', { id, x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw, pitch: pl.pitch, grounded: pl.grounded });
  });

  socket.on('throw_grenade', (d) => {
    socket.broadcast.emit('throw_grenade', {
      x: Number(d.x) || 0,
      y: Number(d.y) || 0,
      z: Number(d.z) || 0,
      vx: Number(d.vx) || 0,
      vy: Number(d.vy) || 0,
      vz: Number(d.vz) || 0,
      type: d.type
    });
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
    io.emit('bullet-impact', {
      ix: Number(d.ix) || 0,
      iy: Number(d.iy) || 0,
      iz: Number(d.iz) || 0,
      nx: Number(d.nx) || 0,
      ny: Number(d.ny) || 0,
      nz: Number(d.nz) || 0
    });
  });

  socket.on('player_hit', (d) => {
    const shooter = players.get(id);
    const target = players.get(d.targetId);
    if (!shooter || !target || id === d.targetId) return;
    const hp = d.hitPoint || {};
    const dr = d.direction || {};
    io.emit('player_hit', {
      shooterId: id,
      targetId: d.targetId,
      hitPart: ['head', 'body', 'limb'].includes(d.hitPart) ? d.hitPart : 'body',
      hitPoint: { x: Number(hp.x) || 0, y: Number(hp.y) || 0, z: Number(hp.z) || 0 },
      direction: { x: Number(dr.x) || 0, y: Number(dr.y) || 0, z: Number(dr.z) || 0 }
    });
  });

  socket.on('invite', (d) => {
    const me = players.get(id);
    if (!me) return;
    const targetCode = parseInt(d.targetId, 10);
    if (!Number.isFinite(targetCode)) { socket.emit('invite_fail', { reason: 'not found' }); return; }
    if (targetCode === me.code) { socket.emit('invite_fail', { reason: 'self' }); return; }
    if (Date.now() - (inviteCooldown.get(id) || 0) < 2000) { socket.emit('invite_fail', { reason: 'cooldown' }); return; }
    let targetSock = null;
    for (const [sid, pl] of players.entries()) {
      if (pl.code === targetCode) { targetSock = io.sockets.sockets.get(sid); break; }
    }
    if (!targetSock) { socket.emit('invite_fail', { reason: 'not found' }); return; }
    inviteCooldown.set(id, Date.now());
    targetSock.emit('invite', { fromCode: me.code, fromId: id });
  });

  socket.on('invite_response', (d) => {
    const me = players.get(id);
    if (!me) return;
    const inviterId = String(d.fromId);
    const inviter = players.get(inviterId);
    const inviterSock = io.sockets.sockets.get(inviterId);
    if (!inviter || !inviterSock) return;
    if (d.accept) {
      me.party = inviterId;
      inviter.party = id;
      inviterSock.emit('party_join', { partnerCode: me.code, partnerId: id, invited: false });
      socket.emit('party_join', {
        partnerCode: inviter.code,
        partnerId: inviterId,
        partnerPos: { x: inviter.x, y: inviter.y, z: inviter.z },
        invited: true
      });
    } else {
      inviterSock.emit('invite_declined', { fromCode: me.code });
    }
  });

  socket.on('disconnect', () => {
    players.delete(id);
    io.emit('player-left', id);
    if (p.party) {
      const ps = io.sockets.sockets.get(p.party);
      if (ps) ps.emit('party_leave', { partnerCode: p.code });
      p.party = null;
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('cs2-web-shooter server listening on', port);
});
