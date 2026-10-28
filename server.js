'use strict';
require('dotenv').config();
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.SESSION_SECRET || '';
const isProd = process.env.NODE_ENV === 'production';
if (SECRET.length < 32 || SECRET.includes('SUBSTITUA')) {
  console.error('ERRO: configure SESSION_SECRET com pelo menos 32 caracteres aleatórios no arquivo .env');
  process.exit(1);
}

const app = express();
if (isProd) app.set('trust proxy', 1); // somente atrás de proxy confiável
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 150000 });
const usersPath = path.join(__dirname, 'data', 'users.json');
const rooms = new Map();
const MAX_MEMBERS = 8;

const sessionMiddleware = session({
  name: 'telaviva.sid',
  secret: SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 12
  }
  // Para escala/produção, troque o MemoryStore por Redis ou equivalente.
});

app.disable('x-powered-by');
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null
    }
  }
}));
app.use(express.json({ limit: '12kb' }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
io.engine.use(sessionMiddleware);

function readUsers() {
  try { return JSON.parse(fs.readFileSync(usersPath, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [salt, expected] = stored.split(':');
  if (!salt || !expected || !/^[0-9a-f]{64}$/i.test(expected)) return false;
  const actual = crypto.scryptSync(password, salt, 32);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return crypto.timingSafeEqual(actual, expectedBuffer);
}
const authRequired = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Faça login para continuar.' });
  next();
};
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' }
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  res.json({ authenticated: true, email: req.session.email });
});
app.post('/api/login', loginLimiter, (req, res, next) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  if (email.length > 180 || typeof password !== 'string' || password.length > 1024) {
    return res.status(400).json({ error: 'Dados inválidos.' });
  }
  const user = readUsers().find((item) => item.email === email);
  // Mesmo sem usuário, executar verificação para reduzir diferença de tempo.
  const dummy = '9f59371dbcd42730ae29e6a815f3fc17:aab3e15cb812b4a34d6bdd6da566eccd0c3940abdbfa9f0cb5f2876be76902be';
  const valid = verifyPassword(password, user?.passwordHash || dummy);
  if (!user || !valid) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      res.json({ authenticated: true, email: user.email });
    });
  });
});
app.post('/api/logout', authRequired, (req, res, next) => {
  const sid = req.sessionID;
  req.session.destroy((err) => {
    if (err) return next(err);
    io.sockets.sockets.forEach((socket) => {
      if (socket.request.sessionID === sid) socket.disconnect(true);
    });
    res.clearCookie('telaviva.sid', { httpOnly: true, secure: isProd, sameSite: 'lax' });
    res.json({ ok: true });
  });
});
app.get('/api/config', authRequired, (req, res) => {
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
      if (Array.isArray(parsed)) iceServers = parsed;
    } catch { console.warn('ICE_SERVERS_JSON inválido; usando STUN padrão.'); }
  }
  res.json({ iceServers, maxMembers: MAX_MEMBERS });
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

io.use((socket, next) => {
  if (!socket.request.session?.userId) return next(new Error('Sessão expirada. Entre novamente.'));
  next();
});

function roomInfo(room) {
  return { code: room.code, members: room.members.size, hasHost: Boolean(room.host), hostId: room.host }; 
}
function notifyMembers(room) {
  io.to(room.code).emit('room:members', roomInfo(room));
}
function getRoom(socket) {
  return socket.data.room ? rooms.get(socket.data.room) : null;
}
function stopHost(room) {
  if (!room?.host) return;
  room.host = null;
  io.to(room.code).emit('share:ended');
}
function leaveRoom(socket) {
  const room = getRoom(socket);
  if (!room) { socket.data.room = null; return; }
  if (room.host === socket.id) stopHost(room);
  room.members.delete(socket.id);
  socket.leave(room.code);
  socket.data.room = null;
  io.to(room.code).emit('peer:left', { id: socket.id });
  if (room.members.size === 0) rooms.delete(room.code);
  else notifyMembers(room);
}
function ackError(ack, error) {
  if (typeof ack === 'function') ack({ ok: false, error });
}
function isValidCode(code) {
  return typeof code === 'string' && /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(code);
}
function makeCode() {
  let code;
  do {
    const hex = crypto.randomBytes(6).toString('hex').toUpperCase();
    code = `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
  } while (rooms.has(code));
  return code;
}
function validSignalPayload(data, maxLength) {
  if (!data || typeof data !== 'object') return false;
  try { return JSON.stringify(data).length <= maxLength; } catch { return false; }
}

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.on('room:create', (ack) => {
    leaveRoom(socket);
    const code = makeCode();
    const room = { code, host: null, members: new Set([socket.id]) };
    rooms.set(code, room);
    socket.data.room = code;
    socket.join(code);
    if (typeof ack === 'function') ack({ ok: true, ...roomInfo(room) });
  });
  socket.on('room:join', (payload, ack) => {
    const code = String(payload?.code || '').trim().toUpperCase();
    if (!isValidCode(code)) return ackError(ack, 'Código de sala inválido.');
    const room = rooms.get(code);
    if (!room) return ackError(ack, 'Sala não encontrada ou encerrada.');
    if (!room.members.has(socket.id) && room.members.size >= MAX_MEMBERS) {
      return ackError(ack, 'Esta sala atingiu o limite de participantes.');
    }
    if (socket.data.room !== code) leaveRoom(socket);
    room.members.add(socket.id);
    socket.data.room = code;
    socket.join(code);
    if (typeof ack === 'function') ack({ ok: true, ...roomInfo(room) });
    notifyMembers(room);
  });
  socket.on('room:leave', (ack) => {
    leaveRoom(socket);
    if (typeof ack === 'function') ack({ ok: true });
  });
  socket.on('share:start', (ack) => {
    const room = getRoom(socket);
    if (!room) return ackError(ack, 'Entre em uma sala antes de compartilhar.');
    if (room.host && room.host !== socket.id) return ackError(ack, 'Outra pessoa já está compartilhando nesta sala.');
    room.host = socket.id;
    if (typeof ack === 'function') ack({ ok: true });
    socket.to(room.code).emit('share:available', { host: socket.id });
    notifyMembers(room);
  });
  socket.on('share:stop', () => {
    const room = getRoom(socket);
    if (room?.host === socket.id) { stopHost(room); notifyMembers(room); }
  });
  socket.on('viewer:ready', () => {
    const room = getRoom(socket);
    if (room?.host && room.host !== socket.id) io.to(room.host).emit('viewer:ready', { id: socket.id });
  });
  socket.on('signal:offer', (payload) => {
    const room = getRoom(socket);
    if (!room || room.host !== socket.id || !room.members.has(payload?.to)) return;
    if (payload.to === socket.id || payload.sdp?.type !== 'offer' || !validSignalPayload(payload.sdp, 100000)) return;
    io.to(payload.to).emit('signal:offer', { from: socket.id, sdp: payload.sdp });
  });
  socket.on('signal:answer', (payload) => {
    const room = getRoom(socket);
    if (!room || room.host !== payload?.to || !room.members.has(payload.to)) return;
    if (payload.sdp?.type !== 'answer' || !validSignalPayload(payload.sdp, 100000)) return;
    io.to(payload.to).emit('signal:answer', { from: socket.id, sdp: payload.sdp });
  });
  socket.on('signal:ice', (payload) => {
    const room = getRoom(socket);
    if (!room || !room.members.has(payload?.to) || !validSignalPayload(payload?.candidate, 12000)) return;
    const validPair = room.host && (room.host === socket.id || room.host === payload.to);
    if (!validPair || payload.to === socket.id) return;
    io.to(payload.to).emit('signal:ice', { from: socket.id, candidate: payload.candidate });
  });
  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tela Viva disponível em http://localhost:${PORT}`);
  console.log(`Usuários cadastrados: ${readUsers().length} (npm run criar-usuario)`);
  if (isProd) console.log('Produção: configure HTTPS no proxy reverso e um serviço TURN.');
});
