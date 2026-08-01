const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, '.')));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 25000, pingTimeout: 20000 });

const players = new Map();
const rooms = new Map();
const playerStats = new Map();
let codeSeq = 2;
const inviteCooldown = new Map();
const chatHistory = new Map();
const antiCheatLog = [];

// Константы для античита
const MAX_MOVEMENT_SPEED = 0.2;
const MAX_SHOTS_PER_SECOND = 10;
const VALID_HIT_PARTS = ['head', 'body', 'limb'];

// Статистика по комнатам
class RoomStats {
  constructor(code) {
    this.code = code;
    this.createdAt = Date.now();
    this.players = new Set();
    this.chatMessages = [];
    this.gameStarted = false;
    this.maxPlayers = 8;
    this.password = null;
  }
  
  addPlayer(playerId) {
    this.players.add(playerId);
  }
  
  removePlayer(playerId) {
    this.players.delete(playerId);
  }
  
  getPlayerCount() {
    return this.players.size;
  }
}

// Статистика игрока
class PlayerStats {
  constructor(playerId) {
    this.playerId = playerId;
    this.kills = 0;
    this.deaths = 0;
    this.headshots = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.joinTime = Date.now();
    this.lastShots = [];
    this.lastPositions = [];
    this.score = 0;
    this.ping = 0;
  }
  
  addKill(isHeadshot = false) {
    this.kills++;
    if (isHeadshot) this.headshots++;
    this.score += isHeadshot ? 5 : 3;
  }
  
  addDeath() {
    this.deaths++;
  }
  
  addShot(hit = false, damage = 0) {
    this.shotsFired++;
    if (hit) {
      this.shotsHit++;
      this.damageDealt += damage;
    }
    const now = Date.now();
    this.lastShots.push(now);
    // Сохраняем только последние 5 секунд
    this.lastShots = this.lastShots.filter(time => now - time < 5000);
  }
  
  takeDamage(damage) {
    this.damageTaken += damage;
  }
  
  updatePing(ping) {
    this.ping = ping;
  }
  
  getAccuracy() {
    return this.shotsFired > 0 ? (this.shotsHit / this.shotsFired * 100).toFixed(1) : 0;
  }
  
  getKDRatio() {
    return this.deaths > 0 ? (this.kills / this.deaths).toFixed(2) : this.kills.toFixed(2);
  }
}

io.on('connection', (socket) => {
  const id = socket.id;
  const p = { 
    x: 0, 
    y: 1.7, 
    z: 0, 
    yaw: 0, 
    pitch: 0, 
    grounded: 1, 
    code: codeSeq++,
    name: `Player${codeSeq - 1}`,
    room: null,
    party: null,
    lastPosition: { x: 0, y: 1.7, z: 0 },
    lastMoveTime: Date.now()
  };
  players.set(id, p);
  playerStats.set(id, new PlayerStats(id));
  
  socket.emit('init', { 
    id, 
    code: p.code,
    name: p.name,
    players: [...players.entries()].map(([k, v]) => ({ 
      id: k, 
      ...v,
      stats: playerStats.get(k) ? {
        kills: playerStats.get(k).kills,
        deaths: playerStats.get(k).deaths,
        score: playerStats.get(k).score
      } : { kills: 0, deaths: 0, score: 0 }
    })) 
  });
  socket.broadcast.emit('player-join', { 
    id, 
    ...p,
    stats: { kills: 0, deaths: 0, score: 0 }
  });
  socket.emit('you_id', { id: p.code, name: p.name });

  socket.on('state', (s) => {
    const pl = players.get(id);
    if (!pl) return;
    
    const newX = Number(s.x) || 0;
    const newY = Number(s.y) || 0;
    const newZ = Number(s.z) || 0;
    const newYaw = Number(s.yaw) || 0;
    const newPitch = Number(s.pitch) || 0;
    
    // Античит: проверка скорости перемещения
    const now = Date.now();
    const timeDelta = now - (pl.lastMoveTime || now);
    const distance = Math.sqrt(
      Math.pow(newX - pl.x, 2) + 
      Math.pow(newY - pl.y, 2) + 
      Math.pow(newZ - pl.z, 2)
    );
    
    const maxDistance = MAX_MOVEMENT_SPEED * (timeDelta / 1000);
    
    if (distance > maxDistance * 1.5 && timeDelta < 1000) {
      // Подозрительное перемещение
      antiCheatLog.push({
        playerId: id,
        action: 'speed_hack',
        time: now,
        details: `Слишком быстрое перемещение: ${distance.toFixed(2)} за ${timeDelta}ms (max: ${maxDistance.toFixed(2)})`
      });
      
      // Корректируем позицию или отклоняем движение
      socket.emit('movement_correction', {
        x: pl.x,
        y: pl.y,
        z: pl.z,
        yaw: pl.yaw,
        pitch: pl.pitch
      });
      return;
    }
    
    // Сохраняем историю позиций для анализа
    pl.lastPositions.push({ x: newX, y: newY, z: newZ, time: now });
    if (pl.lastPositions.length > 10) {
      pl.lastPositions.shift();
    }
    
    // Обновляем позицию
    pl.x = newX;
    pl.y = newY;
    pl.z = newZ;
    pl.yaw = newYaw;
    pl.pitch = newPitch;
    pl.grounded = s.grounded ? 1 : 0;
    pl.lastPosition = { x: newX, y: newY, z: newZ };
    pl.lastMoveTime = now;
    
    socket.broadcast.emit('player-move', { 
      id, 
      x: pl.x, 
      y: pl.y, 
      z: pl.z, 
      yaw: pl.yaw, 
      pitch: pl.pitch, 
      grounded: pl.grounded 
    });
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
    const pl = players.get(id);
    const stats = playerStats.get(id);
    if (!pl || !stats) return;
    
    // Античит: проверка скорости стрельбы
    const now = Date.now();
    const shotsLastSecond = stats.lastShots.filter(time => now - time < 1000).length;
    
    if (shotsLastSecond >= MAX_SHOTS_PER_SECOND) {
      antiCheatLog.push({
        playerId: id,
        action: 'rapid_fire',
        time: now,
        details: `Слишком быстрая стрельба: ${shotsLastSecond} выстрелов/сек`
      });
      socket.emit('shoot_blocked', { reason: 'Слишком быстрая стрельба' });
      return;
    }
    
    // Добавляем выстрел в статистику
    stats.addShot();
    
    // Проверка позиции выстрела
    const shootX = Number(d.x) || 0;
    const shootY = Number(d.y) || 0;
    const shootZ = Number(d.z) || 0;
    
    // Расстояние от текущей позиции игрока
    const distanceFromPlayer = Math.sqrt(
      Math.pow(shootX - pl.x, 2) + 
      Math.pow(shootY - pl.y, 2) + 
      Math.pow(shootZ - pl.z, 2)
    );
    
    if (distanceFromPlayer > 5) {
      // Выстрел слишком далеко от игрока
      antiCheatLog.push({
        playerId: id,
        action: 'shoot_position_hack',
        time: now,
        details: `Выстрел далеко от игрока: ${distanceFromPlayer.toFixed(2)} units`
      });
    }
    
    socket.broadcast.emit('player-shoot', {
      id,
      x: shootX,
      y: shootY,
      z: shootZ,
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
    
    const shooterStats = playerStats.get(id);
    const targetStats = playerStats.get(d.targetId);
    
    if (!shooterStats || !targetStats) return;
    
    const hp = d.hitPoint || {};
    const dr = d.direction || {};
    const hitPart = ['head', 'body', 'limb'].includes(d.hitPart) ? d.hitPart : 'body';
    const damage = hitPart === 'head' ? 100 : hitPart === 'body' ? 50 : 30;
    
    // Античит: проверка дистанции выстрела
    const hitPoint = { x: Number(hp.x) || 0, y: Number(hp.y) || 0, z: Number(hp.z) || 0 };
    const shooterDistance = Math.sqrt(
      Math.pow(hitPoint.x - shooter.x, 2) + 
      Math.pow(hitPoint.y - shooter.y, 2) + 
      Math.pow(hitPoint.z - shooter.z, 2)
    );
    
    const targetDistance = Math.sqrt(
      Math.pow(hitPoint.x - target.x, 2) + 
      Math.pow(hitPoint.y - target.y, 2) + 
      Math.pow(hitPoint.z - target.z, 2)
    );
    
    // Проверка на невозможные попадания
    if (shooterDistance > 100) {
      antiCheatLog.push({
        playerId: id,
        action: 'distance_hack',
        time: Date.now(),
        details: `Выстрел с дистанции: ${shooterDistance.toFixed(2)} units`
      });
    }
    
    if (targetDistance > 2) {
      antiCheatLog.push({
        playerId: id,
        action: 'hit_position_hack',
        time: Date.now(),
        details: `Попадание далеко от цели: ${targetDistance.toFixed(2)} units`
      });
    }
    
    // Обновляем статистику
    const isHeadshot = hitPart === 'head';
    shooterStats.addKill(isHeadshot);
    targetStats.addDeath();
    shooterStats.addShot(true, damage);
    targetStats.takeDamage(damage);
    
    // Отправляем уведомление о попадании
    io.emit('player_hit', {
      shooterId: id,
      shooterName: shooter.name,
      targetId: d.targetId,
      targetName: target.name,
      hitPart: hitPart,
      hitPoint: hitPoint,
      direction: { x: Number(dr.x) || 0, y: Number(dr.y) || 0, z: Number(dr.z) || 0 },
      damage: damage,
      isHeadshot: isHeadshot
    });
    
    // Обновляем статистику для всех в комнате
    if (shooter.room) {
      io.to(shooter.room).emit('player_stats_update', {
        playerId: id,
        kills: shooterStats.kills,
        deaths: shooterStats.deaths,
        score: shooterStats.score
      });
      
      io.to(shooter.room).emit('player_stats_update', {
        playerId: d.targetId,
        kills: targetStats.kills,
        deaths: targetStats.deaths,
        score: targetStats.score
      });
    }
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

  socket.on('trade_offer', (d) => {
    const me = players.get(id);
    if (!me) return;
    const targetCode = parseInt(d.targetId, 10);
    if (!Number.isFinite(targetCode) || targetCode === me.code) { socket.emit('trade_fail', { reason: 'not found' }); return; }
    let targetSock = null;
    for (const [sid, pl] of players.entries()) {
      if (pl.code === targetCode) { targetSock = io.sockets.sockets.get(sid); break; }
    }
    if (!targetSock) { socket.emit('trade_fail', { reason: 'not found' }); return; }
    if (Date.now() - (inviteCooldown.get(id) || 0) < 1500) { socket.emit('trade_fail', { reason: 'cooldown' }); return; }
    const items = Array.isArray(d.items) ? d.items.filter(i => typeof i === 'string').slice(0, 8) : [];
    if (!items.length) { socket.emit('trade_fail', { reason: 'no items' }); return; }
    inviteCooldown.set(id, Date.now());
    targetSock.emit('trade_offer', { fromCode: me.code, fromId: id, items });
  });

  socket.on('trade_response', (d) => {
    const me = players.get(id);
    if (!me) return;
    const traderId = String(d.fromId);
    const trader = players.get(traderId);
    const traderSock = io.sockets.sockets.get(traderId);
    if (!trader || !traderSock) return;
    if (d.accept) {
      const myItems = Array.isArray(d.items) ? d.items.filter(i => typeof i === 'string').slice(0, 8) : [];
      const theirItems = Array.isArray(d.theirItems) ? d.theirItems.filter(i => typeof i === 'string').slice(0, 8) : [];
      traderSock.emit('trade_done', { partnerCode: me.code, yourItems: myItems, theirItems });
      socket.emit('trade_done', { partnerCode: trader.code, yourItems: theirItems, theirItems: myItems });
    } else {
      traderSock.emit('trade_declined', { fromCode: me.code });
    }
  });

  socket.on('set_room', (d) => {
    const me = players.get(id);
    if (!me) return;
    const code = String((d && d.code) || '').trim().slice(0, 12);
    const password = String((d && d.password) || '').trim();
    
    // Проверка античита: слишком частая смена комнат
    const now = Date.now();
    if (me.lastRoomChange && now - me.lastRoomChange < 1000) {
      socket.emit('room_error', { reason: 'Слишком частая смена комнат' });
      antiCheatLog.push({
        playerId: id,
        action: 'room_spam',
        time: now,
        details: `Частая смена комнат: ${me.room} -> ${code}`
      });
      return;
    }
    me.lastRoomChange = now;
    
    // Выход из текущей комнаты
    if (me.room && me.room !== code) {
      const old = rooms.get(me.room);
      if (old) { 
        old.removePlayer(id); 
        socket.broadcast.to(me.room).emit('room_message', {
          type: 'leave',
          player: me.name,
          code: me.code
        });
        
        // Отправляем обновленную статистику комнаты
        io.to(me.room).emit('room_update', {
          code: me.room,
          players: Array.from(old.players).map(pid => {
            const p = players.get(pid);
            const stats = playerStats.get(pid);
            return {
              id: pid,
              name: p ? p.name : 'Unknown',
              code: p ? p.code : 0,
              kills: stats ? stats.kills : 0,
              deaths: stats ? stats.deaths : 0,
              score: stats ? stats.score : 0
            };
          }),
          playerCount: old.getPlayerCount(),
          maxPlayers: old.maxPlayers
        });
        
        if (!old.getPlayerCount()) {
          rooms.delete(me.room);
          chatHistory.delete(me.room);
        }
      }
    }
    
    // Выход из партии
    if (me.party) {
      const partner = players.get(me.party);
      if (partner) {
        partner.party = null;
        const ps = io.sockets.sockets.get(me.party);
        if (ps) ps.emit('party_leave', { partnerCode: me.code });
      }
      me.party = null;
    }
    
    me.room = code || null;
    if (!code) { 
      socket.emit('room_joined', { code: '' }); 
      return; 
    }
    
    // Создание или присоединение к комнате
    if (!rooms.has(code)) {
      rooms.set(code, new RoomStats(code));
      if (password) {
        rooms.get(code).password = password;
      }
      chatHistory.set(code, []);
    } else {
      // Проверка пароля
      const room = rooms.get(code);
      if (room.password && room.password !== password) {
        socket.emit('room_error', { reason: 'Неверный пароль' });
        return;
      }
      
      // Проверка заполненности комнаты
      if (room.getPlayerCount() >= room.maxPlayers) {
        socket.emit('room_error', { reason: 'Комната заполнена' });
        return;
      }
    }
    
    const room = rooms.get(code);
    room.addPlayer(id);
    
    // Отправляем историю чата
    if (chatHistory.has(code)) {
      socket.emit('chat_history', {
        room: code,
        messages: chatHistory.get(code).slice(-50)
      });
    }
    
    socket.join(code);
    socket.emit('room_joined', { 
      code,
      hasPassword: !!room.password,
      playerCount: room.getPlayerCount(),
      maxPlayers: room.maxPlayers
    });
    
    // Уведомляем других игроков в комнате
    socket.broadcast.to(code).emit('room_message', {
      type: 'join',
      player: me.name,
      code: me.code
    });
    
    // Отправляем обновленную статистику комнаты
    io.to(code).emit('room_update', {
      code,
      players: Array.from(room.players).map(pid => {
        const p = players.get(pid);
        const stats = playerStats.get(pid);
        return {
          id: pid,
          name: p ? p.name : 'Unknown',
          code: p ? p.code : 0,
          kills: stats ? stats.kills : 0,
          deaths: stats ? stats.deaths : 0,
          score: stats ? stats.score : 0
        };
      }),
      playerCount: room.getPlayerCount(),
      maxPlayers: room.maxPlayers
    });
    
    // Автоматическое создание партии если игроков 2
    if (room.getPlayerCount() === 2 && !me.party) {
      for (const sid of room.players) {
        if (sid === id) continue;
        const mate = players.get(sid);
        if (!mate || mate.party || mate.room !== code) continue;
        me.party = sid;
        mate.party = id;
        const mateSock = io.sockets.sockets.get(sid);
        if (mateSock) mateSock.emit('party_join', { partnerCode: me.code, partnerId: id, invited: false, room: true });
        socket.emit('party_join', { partnerCode: mate.code, partnerId: sid, invited: false, room: true });
        break;
      }
    }
  });
  
  // Система чата
  socket.on('chat_message', (d) => {
    const me = players.get(id);
    if (!me) return;
    
    const message = String(d.message || '').trim().slice(0, 200);
    if (!message) return;
    
    // Проверка античита: спам в чат
    const now = Date.now();
    if (me.lastChatMessage && now - me.lastChatMessage < 1000) {
      socket.emit('chat_error', { reason: 'Слишком много сообщений' });
      antiCheatLog.push({
        playerId: id,
        action: 'chat_spam',
        time: now,
        details: `Спам в чат: ${message.substring(0, 50)}...`
      });
      return;
    }
    me.lastChatMessage = now;
    
    // Проверка на нецензурную лексику (базовая)
    const bannedWords = ['админ', 'читер', 'хак'];
    const hasBannedWord = bannedWords.some(word => 
      message.toLowerCase().includes(word.toLowerCase())
    );
    
    if (hasBannedWord) {
      socket.emit('chat_error', { reason: 'Сообщение содержит запрещенные слова' });
      return;
    }
    
    const chatMessage = {
      playerId: id,
      playerName: me.name,
      playerCode: me.code,
      message: message,
      timestamp: now,
      type: d.type || 'room' // room, global, team
    };
    
    if (me.room && d.type !== 'global') {
      // Комнатный чат
      if (!chatHistory.has(me.room)) {
        chatHistory.set(me.room, []);
      }
      chatHistory.get(me.room).push(chatMessage);
      // Сохраняем только последние 100 сообщений
      if (chatHistory.get(me.room).length > 100) {
        chatHistory.get(me.room).shift();
      }
      
      io.to(me.room).emit('chat_message', chatMessage);
    } else {
      // Глобальный чат
      io.emit('chat_message', chatMessage);
    }
  });
  
  // Запрос статистики
  socket.on('get_stats', (d) => {
    const me = players.get(id);
    const stats = playerStats.get(id);
    
    if (!me || !stats) {
      socket.emit('stats_error', { reason: 'Статистика не найдена' });
      return;
    }
    
    const targetId = d && d.playerId;
    if (targetId && targetId !== id) {
      const targetStats = playerStats.get(targetId);
      const targetPlayer = players.get(targetId);
      if (targetStats && targetPlayer) {
        socket.emit('player_stats', {
          playerId: targetId,
          playerName: targetPlayer.name,
          playerCode: targetPlayer.code,
          kills: targetStats.kills,
          deaths: targetStats.deaths,
          headshots: targetStats.headshots,
          damageDealt: targetStats.damageDealt,
          damageTaken: targetStats.damageTaken,
          shotsFired: targetStats.shotsFired,
          shotsHit: targetStats.shotsHit,
          accuracy: targetStats.getAccuracy(),
          kdRatio: targetStats.getKDRatio(),
          score: targetStats.score,
          ping: targetStats.ping
        });
      }
    } else {
      // Своя статистика
      socket.emit('player_stats', {
        playerId: id,
        playerName: me.name,
        playerCode: me.code,
        kills: stats.kills,
        deaths: stats.deaths,
        headshots: stats.headshots,
        damageDealt: stats.damageDealt,
        damageTaken: stats.damageTaken,
        shotsFired: stats.shotsFired,
        shotsHit: stats.shotsHit,
        accuracy: stats.getAccuracy(),
        kdRatio: stats.getKDRatio(),
        score: stats.score,
        ping: stats.ping
      });
    }
  });
  
  // Таблица лидеров
  socket.on('get_leaderboard', () => {
    const leaderboard = Array.from(playerStats.entries())
      .filter(([pid, stats]) => stats.kills > 0 || stats.score > 0)
      .map(([pid, stats]) => {
        const player = players.get(pid);
        return {
          playerId: pid,
          playerName: player ? player.name : 'Unknown',
          playerCode: player ? player.code : 0,
          kills: stats.kills,
          deaths: stats.deaths,
          headshots: stats.headshots,
          accuracy: stats.getAccuracy(),
          kdRatio: stats.getKDRatio(),
          score: stats.score
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    
    socket.emit('leaderboard', leaderboard);
  });
  
  // Статистика комнаты
  socket.on('get_room_stats', (d) => {
    const code = String(d && d.code || '').trim();
    if (!code || !rooms.has(code)) {
      socket.emit('room_stats_error', { reason: 'Комната не найдена' });
      return;
    }
    
    const room = rooms.get(code);
    const roomStats = Array.from(room.players).map(pid => {
      const player = players.get(pid);
      const stats = playerStats.get(pid);
      return {
        playerId: pid,
        playerName: player ? player.name : 'Unknown',
        playerCode: player ? player.code : 0,
        kills: stats ? stats.kills : 0,
        deaths: stats ? stats.deaths : 0,
        headshots: stats ? stats.headshots : 0,
        score: stats ? stats.score : 0,
        accuracy: stats ? stats.getAccuracy() : 0,
        ping: stats ? stats.ping : 0
      };
    }).sort((a, b) => b.score - a.score);
    
    socket.emit('room_stats', {
      code,
      stats: roomStats,
      playerCount: room.getPlayerCount(),
      maxPlayers: room.maxPlayers,
      createdAt: room.createdAt
    });
  });
  
  // Смена ника
  socket.on('set_name', (d) => {
    const me = players.get(id);
    if (!me) return;
    
    const newName = String(d.name || '').trim().slice(0, 16);
    if (!newName || newName.length < 2) {
      socket.emit('name_error', { reason: 'Слишком короткое имя' });
      return;
    }
    
    // Проверка на нецензурные имена
    const bannedNames = ['admin', 'moderator', 'system'];
    if (bannedNames.some(word => newName.toLowerCase().includes(word.toLowerCase()))) {
      socket.emit('name_error', { reason: 'Недопустимое имя' });
      return;
    }
    
    const oldName = me.name;
    me.name = newName;
    
    socket.emit('name_changed', { newName });
    
    // Уведомляем комнату
    if (me.room) {
      io.to(me.room).emit('player_name_changed', {
        playerId: id,
        oldName,
        newName,
        playerCode: me.code
      });
    }
  });
  
  // Пинг клиента для античита
  socket.on('client_ping', (d) => {
    const me = players.get(id);
    const stats = playerStats.get(id);
    if (!me || !stats) return;
    
    const ping = Number(d.ping) || 0;
    stats.updatePing(ping);
    
    // Проверка на нереальный пинг (менее 1ms или более 1000ms может быть признаком читерства)
    if (ping < 1 || ping > 1000) {
      antiCheatLog.push({
        playerId: id,
        action: 'suspicious_ping',
        time: Date.now(),
        details: `Подозрительный пинг: ${ping}ms`
      });
    }
  });

  socket.on('disconnect', () => {
    const me = players.get(id);
    if (!me) return;
    
    // Уведомляем о выходе
    io.emit('player-left', { id, name: me.name, code: me.code });
    
    // Выход из комнаты
    if (me.room) {
      const room = rooms.get(me.room);
      if (room) { 
        room.removePlayer(id); 
        io.to(me.room).emit('room_message', {
          type: 'disconnect',
          player: me.name,
          code: me.code
        });
        
        // Отправляем обновленную статистику комнаты
        io.to(me.room).emit('room_update', {
          code: me.room,
          players: Array.from(room.players).map(pid => {
            const p = players.get(pid);
            const stats = playerStats.get(pid);
            return {
              id: pid,
              name: p ? p.name : 'Unknown',
              code: p ? p.code : 0,
              kills: stats ? stats.kills : 0,
              deaths: stats ? stats.deaths : 0,
              score: stats ? stats.score : 0
            };
          }),
          playerCount: room.getPlayerCount(),
          maxPlayers: room.maxPlayers
        });
        
        if (!room.getPlayerCount()) {
          rooms.delete(me.room);
          chatHistory.delete(me.room);
        }
      }
    }
    
    // Выход из партии
    if (me.party) {
      const partner = players.get(me.party);
      if (partner) {
        partner.party = null;
        const ps = io.sockets.sockets.get(me.party);
        if (ps) ps.emit('party_leave', { partnerCode: me.code });
      }
      me.party = null;
    }
    
    // Очищаем данные
    players.delete(id);
    playerStats.delete(id);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('cs2-web-shooter server listening on', port);
});
