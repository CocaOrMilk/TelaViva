'use strict';
// Teste de ponta a ponta da API HTTP: sobe o servidor com uma pasta de dados temporária.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const EMAIL = 'teste@example.com';
const PASSWORD = 'senha-de-teste-123';
let server, base, dataDir;
const jar = new Map();

async function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
async function call(method, url, body, extra = {}) {
  const headers = { ...(extra.headers || {}) };
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : (extra.raw ? body : JSON.stringify(body)) });
  for (const cookie of response.headers.getSetCookie?.() || []) { const [pair] = cookie.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
  let json = null; try { json = await response.json(); } catch { /* sem corpo JSON */ }
  return { status: response.status, json };
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telaviva-test-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify([{ id: 'u1', email: EMAIL, passwordHash: `${salt}:${crypto.scryptSync(PASSWORD, salt, 32).toString('hex')}` }]));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, NODE_ENV: 'development', SESSION_SECRET: crypto.randomBytes(32).toString('hex') },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('servidor não subiu')), 10000);
    server.stdout.on('data', (d) => { if (String(d).includes('disponível')) { clearTimeout(timer); resolve(); } });
  });
});
test.after(() => { server?.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('rotas protegidas exigem login', async () => {
  assert.equal((await call('GET', '/api/me')).json.authenticated, false);
  assert.equal((await call('GET', '/api/config')).status, 401);
  assert.equal((await call('POST', '/api/report', { events: [] })).status, 401);
  assert.equal((await call('POST', '/api/change-password', {})).status, 401);
});

test('login: senha errada falha, certa entra', async () => {
  assert.equal((await call('POST', '/api/login', { email: EMAIL, password: 'errada-errada' })).status, 401);
  const ok = await call('POST', '/api/login', { email: EMAIL, password: PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/me')).json.email, EMAIL);
});

test('configuração de ICE/limites', async () => {
  const { status, json } = await call('GET', '/api/config');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.iceServers) && json.maxSharers === 3);
});

test('relatório de erro é gravado no log do servidor', async () => {
  const r = await call('POST', '/api/report', { events: [{ t: 1, type: 'erro', msg: 'x' }], context: { app: 'teste' }, note: 'teste' });
  assert.equal(r.status, 200);
  const line = fs.readFileSync(path.join(dataDir, 'logs', 'telaviva.log'), 'utf8').trim().split('\n').pop();
  assert.equal(JSON.parse(line).kind, 'client-report');
});

test('teste de upload aceita o corpo binário', async () => {
  const r = await call('POST', '/api/speedtest', new Uint8Array(100000), { headers: { 'Content-Type': 'application/octet-stream' }, raw: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.bytes, 100000);
});

test('trocar senha: valida e persiste', async () => {
  assert.equal((await call('POST', '/api/change-password', { currentPassword: 'errada-errada', newPassword: 'nova-senha-forte-1' })).status, 403);
  assert.equal((await call('POST', '/api/change-password', { currentPassword: PASSWORD, newPassword: 'curta' })).status, 400);
  assert.equal((await call('POST', '/api/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD })).status, 400);
  assert.equal((await call('POST', '/api/change-password', { currentPassword: PASSWORD, newPassword: 'nova-senha-forte-1' })).status, 200);
  jar.clear();
  assert.equal((await call('POST', '/api/login', { email: EMAIL, password: PASSWORD })).status, 401);
  assert.equal((await call('POST', '/api/login', { email: EMAIL, password: 'nova-senha-forte-1' })).status, 200);
});
