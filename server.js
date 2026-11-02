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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const usersPath = path.join(DATA_DIR, 'users.json');
// Salas fixas: ninguém cria salas, só entra em uma das pré-configuradas.
// Nomes opcionais via ROOM_NAMES="Jogos,Filmes,Conversa" (sempre 3 salas).
const ROOM_NAMES = String(process.env.ROOM_NAMES || '').split(',').map((n) => n.trim()).filter(Boolean);
const rooms = new Map([1, 2, 3].map((n) => {
  const code = `sala-${n}`;
  return [code, { code, name: (ROOM_NAMES[n - 1] || `Sala ${n}`).slice(0, 30), sharers: new Set(), members: new Set() }];
}));
const MAX_MEMBERS = 8;
const MAX_SHARERS = 3;

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
const smallJson = express.json({ limit: '12kb' });
app.use((req, res, next) => (req.path === '/api/report' ? next() : smallJson(req, res, next)));
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

// ---- registro de erros ---------------------------------------------------
// Arquivo JSONL em <DATA_DIR>/logs/telaviva.log (rotaciona em 2 MB, guarda 1 anterior).
// Recebe erros do servidor automaticamente e relatórios que o usuário escolhe enviar.
const LOG_ROOT = typeof DATA_DIR === 'string' ? DATA_DIR : path.join(__dirname, 'data');
const LOG_DIR = path.join(LOG_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'telaviva.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024;
function writeLog(kind, data = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    try { if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch { /* ainda não existe */ }
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n', { mode: 0o600 });
  } catch (e) { console.error('Falha ao gravar o log:', e.message); }
}
const clip = (value, max) => String(value ?? '').slice(0, max);
const reportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Muitos relatórios enviados. Tente novamente em alguns minutos.' }
});
app.post('/api/report', reportLimiter, authRequired, express.json({ limit: '120kb' }), (req, res) => {
  const body = req.body || {};
  const events = (Array.isArray(body.events) ? body.events : []).slice(-100).map((e) => ({
    t: Number(e?.t) || 0, type: clip(e?.type, 30), msg: clip(e?.msg, 400)
  }));
  let context = {};
  try { const text = JSON.stringify(body.context || {}); if (text.length <= 6000) context = JSON.parse(text); } catch { /* ignora */ }
  const id = crypto.randomBytes(4).toString('hex');
  writeLog('client-report', { id, user: req.session.email, ua: clip(req.get('user-agent'), 200), note: clip(body.note, 500), context, events });
  res.json({ ok: true, id });
});
process.on('unhandledRejection', (reason) => writeLog('server-unhandled-rejection', { error: clip(reason?.stack || reason, 2000) }));
process.on('uncaughtException', (err) => { writeLog('server-uncaught-exception', { error: clip(err?.stack || err, 2000) }); console.error(err); process.exit(1); });


// ---- troca de senha pelo próprio usuário -----------------------------------
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `pw:${req.session?.userId || req.ip}`,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' }
});
app.post('/api/change-password', passwordLimiter, authRequired, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || currentPassword.length > 1024 || newPassword.length > 200) {
    return res.status(400).json({ error: 'Dados inválidos.' });
  }
  if (newPassword.length < 10) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 10 caracteres.' });
  const users = readUsers();
  const user = users.find((item) => item.id === req.session.userId);
  if (!user || !verifyPassword(currentPassword, user.passwordHash)) return res.status(403).json({ error: 'A senha atual está incorreta.' });
  if (newPassword === currentPassword) return res.status(400).json({ error: 'A nova senha deve ser diferente da atual.' });
  const salt = crypto.randomBytes(16).toString('hex');
  user.passwordHash = `${salt}:${crypto.scryptSync(newPassword, salt, 32).toString('hex')}`;
  const tmp = `${usersPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, usersPath);
  writeLog('password-changed', { user: user.email });
  res.json({ ok: true });
});


// ---- medição de upload (o site usa para dividir a banda entre os espectadores) ----
const speedLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `speed:${req.session?.userId || 'x'}`,
  message: { error: 'Muitos testes seguidos.' }
});
app.post('/api/speedtest', speedLimiter, authRequired, express.raw({ type: 'application/octet-stream', limit: '4mb' }), (req, res) => {
  res.json({ ok: true, bytes: Buffer.isBuffer(req.body) ? req.body.length : 0 });
});

app.get('/api/config', authRequired, (req, res) => {
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
      if (Array.isArray(parsed)) iceServers = parsed;
    } catch { console.warn('ICE_SERVERS_JSON inválido; usando STUN padrão.'); }
  }
  res.json({ iceServers, maxMembers: MAX_MEMBERS, maxSharers: MAX_SHARERS });
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (!(err?.status >= 400 && err?.status < 500)) writeLog('server-error', { method: req.method, url: clip(req.originalUrl, 200), user: req.session?.email, error: clip(err?.stack || err, 2000) });
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

io.use((socket, next) => {
  if (!socket.request.session?.userId) return next(new Error('Sessão expirada. Entre novamente.'));
  next();
});

function roomInfo(room) {
  return { code: room.code, name: room.name, members: room.members.size, sharers: [...room.sharers], maxSharers: MAX_SHARERS };
}
function roomsList() {
  return [...rooms.values()].map((r) => ({ code: r.code, name: r.name, members: r.members.size, sharers: r.sharers.size, maxMembers: MAX_MEMBERS }));
}
function notifyMembers(room) {
  io.to(room.code).emit('room:members', roomInfo(room));
  io.emit('rooms:list', roomsList()); // atualiza a lista de salas de todos
}
function getRoom(socket) {
  return socket.data.room ? rooms.get(socket.data.room) : null;
}
function stopSharing(room, id) {
  if (!room?.sharers.delete(id)) return;
  io.to(room.code).emit('share:ended', { host: id });
}
function leaveRoom(socket) {
  const room = getRoom(socket);
  if (!room) { socket.data.room = null; return; }
  stopSharing(room, socket.id);
  room.members.delete(socket.id);
  socket.leave(room.code);
  socket.data.room = null;
  io.to(room.code).emit('peer:left', { id: socket.id });
  notifyMembers(room); // as salas fixas continuam existindo mesmo vazias
}
function ackError(ack, error) {
  if (typeof ack === 'function') ack({ ok: false, error });
}
function validSignalPayload(data, maxLength) {
  if (!data || typeof data !== 'object') return false;
  try { return JSON.stringify(data).length <= maxLength; } catch { return false; }
}

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.on('rooms:list', (ack) => { if (typeof ack === 'function') ack({ ok: true, rooms: roomsList() }); });
  socket.on('room:join', (payload, ack) => {
    const code = String(payload?.code || '').trim().toLowerCase();
    const room = rooms.get(code);
    if (!room) return ackError(ack, 'Sala não encontrada.');
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
    if (!room.sharers.has(socket.id) && room.sharers.size >= MAX_SHARERS) {
      return ackError(ack, 'Esta sala já tem três transmissões ativas.');
    }
    room.sharers.add(socket.id);
    if (typeof ack === 'function') ack({ ok: true });
    socket.to(room.code).emit('share:available', { host: socket.id });
    notifyMembers(room);
  });
  socket.on('share:stop', () => {
    const room = getRoom(socket);
    if (room?.sharers.has(socket.id)) { stopSharing(room, socket.id); notifyMembers(room); }
  });
  socket.on('viewer:ready', (payload) => {
    const room = getRoom(socket);
    const host = payload?.host;
    if (room?.sharers.has(host) && room.members.has(socket.id) && host !== socket.id) {
      io.to(host).emit('viewer:ready', { id: socket.id });
    }
  });
  socket.on('signal:offer', (payload) => {
    const room = getRoom(socket);
    if (!room?.sharers.has(socket.id) || !room.members.has(payload?.to)) return;
    if (payload.to === socket.id || payload.sdp?.type !== 'offer' || !validSignalPayload(payload.sdp, 100000)) return;
    io.to(payload.to).emit('signal:offer', { from: socket.id, sdp: payload.sdp });
  });
  socket.on('signal:answer', (payload) => {
    const room = getRoom(socket);
    if (!room?.sharers.has(payload?.to) || !room.members.has(payload.to)) return;
    if (payload.sdp?.type !== 'answer' || !validSignalPayload(payload.sdp, 100000)) return;
    io.to(payload.to).emit('signal:answer', { from: socket.id, sdp: payload.sdp });
  });
  socket.on('signal:ice', (payload) => {
    const room = getRoom(socket);
    if (!room || !room.members.has(payload?.to) || !['viewer','presenter'].includes(payload?.target) || !validSignalPayload(payload?.candidate, 12000)) return;
    const validPair = payload.target === 'viewer' ? room.sharers.has(socket.id) : room.sharers.has(payload?.to);
    if (!validPair || payload.to === socket.id) return;
    io.to(payload.to).emit('signal:ice', { from: socket.id, target: payload.target, candidate: payload.candidate });
  });
  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`Tela Viva disponível em http://localhost:${PORT}`);
  console.log(`Usuários cadastrados: ${readUsers().length} (npm run criar-usuario)`);
  if (isProd) console.log('Produção: configure HTTPS no proxy reverso e um serviço TURN.');
});
