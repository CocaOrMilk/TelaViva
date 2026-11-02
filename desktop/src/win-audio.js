'use strict';
// Roteamento de áudio no Windows: conversa com o helper nativo tv-audio-win.exe (Process Loopback API),
// que captura cada programa separadamente (Discord e o próprio TelaViva ficam de fora), aplica o volume da
// transmissão e devolve o áudio já mixado. O PCM segue para a página (AudioWorklet) por IPC.
// Protocolo do helper: ver native/win/tv-audio-win.cpp.

const { spawn } = require('node:child_process');
const path = require('node:path');

const DISCORD_NAMES = ['discord.exe', 'discordptb.exe', 'discordcanary.exe', 'discorddevelopment.exe', 'vesktop.exe', 'webcord.exe', 'armcord.exe', 'legcord.exe'];

function helperCommand() {
  if (process.env.TV_AUDIO_HELPER_CMD) { // testes (ex.: "wine /caminho/tv-audio-win.exe")
    const [cmd, ...args] = process.env.TV_AUDIO_HELPER_CMD.split(' ');
    return { cmd, args };
  }
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'tv-audio-win.exe');
  const dev = path.join(__dirname, '..', 'build', 'win', 'tv-audio-win.exe');
  return { cmd: require('node:fs').existsSync(packaged || '') ? packaged : dev, args: [] };
}

function createRouter({ log = () => {}, onPcm = () => {}, onProblem = () => {} } = {}) {
  let child = null;
  let running = false;
  let includeDiscord = false;
  let last = { apps: [], master: 100 };
  let lastError = null;
  let buf = Buffer.alloc(0);
  let pending = [];      // blocos de 10 ms acumulados para enviar juntos (~40 ms)
  let firstFrame = null;

  function handleFrame(type, payload) {
    if (type === 1) {
      pending.push(payload);
      if (firstFrame) { firstFrame(); firstFrame = null; }
      if (pending.length >= 4) { onPcm(Buffer.concat(pending)); pending = []; }
    } else if (type === 2) {
      try { last = JSON.parse(payload.toString('utf8')); } catch { /* ignora */ }
    } else if (type === 3) {
      try { lastError = JSON.parse(payload.toString('utf8')).error; log(`helper: ${lastError}`); onProblem('helper de áudio do Windows', lastError); } catch { /* ignora */ }
    }
  }
  function onData(chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const len = buf.readUInt32LE(1);
      if (buf.length < 5 + len) break;
      handleFrame(buf[0], buf.subarray(5, 5 + len));
      buf = buf.subarray(5 + len);
    }
  }
  const send = (...fields) => { if (child && child.stdin.writable) child.stdin.write(fields.join('\t') + '\n'); };

  async function start(opts = {}) {
    const wantDiscord = !!opts.includeDiscord;
    if (running && wantDiscord !== includeDiscord) await stop();
    if (running) return status();
    includeDiscord = wantDiscord;
    const { cmd, args } = helperCommand();
    const full = [...args, '--exclude-pid', String(process.pid)];
    if (!includeDiscord) full.push('--exclude-names', DISCORD_NAMES.join(','));
    if (process.env.TV_AUDIO_SYNTHETIC) full.push('--synthetic');
    lastError = null; last = { apps: [], master: 100 }; buf = Buffer.alloc(0); pending = [];
    child = spawn(cmd, full, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const proc = child;
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => log(`helper stderr: ${String(d).slice(0, 200)}`));
    const started = new Promise((resolve, reject) => {
      firstFrame = resolve;
      proc.once('error', (e) => reject(new Error(`Não foi possível iniciar o helper de áudio: ${e.message}`)));
      proc.once('exit', (code) => { if (running) onProblem('helper de áudio encerrou sozinho', `código ${code}; ${lastError || 'sem mensagem'}`); running = false; if (firstFrame) { firstFrame = null; reject(new Error(`O helper de áudio encerrou (código ${code}). ${lastError || ''}`.trim())); } });
      setTimeout(() => { if (firstFrame) { firstFrame = null; reject(new Error('O helper de áudio não respondeu.')); } }, 6000);
    });
    try { await started; } catch (e) { try { proc.kill(); } catch { /* já saiu */ } child = null; onProblem('helper de áudio não iniciou', `${e.message}; apps: ${(last.apps || []).map((a) => a.key).join(',')}`); throw e; }
    running = true;
    log(`áudio do Windows ativo (${includeDiscord ? 'com Discord' : 'sem Discord'})`);
    return status();
  }
  async function stop() {
    const proc = child;
    running = false; child = null; pending = [];
    if (!proc) return status();
    send('quit');
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { proc.kill(); } catch { /* ok */ } resolve(); }, 1500);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
    log('áudio do Windows encerrado');
    return status();
  }
  const clamp = (v, max) => Math.min(max, Math.max(0, Math.round(Number(v))));
  async function listApps() {
    if (!running) return [];
    return (last.apps || []).map((a) => ({ key: a.key, name: a.name, active: a.active, local: a.local, tx: a.tx }));
  }
  async function setAppVolume(key, which, percent) {
    if (which !== 'local' && which !== 'tx') throw new Error('Destino inválido.');
    const pct = clamp(percent, which === 'local' ? 100 : 150);
    if (!Number.isFinite(pct)) throw new Error('Volume inválido.');
    send(which === 'local' ? 'local' : 'tx', key, pct);
    return { key, which, volume: pct };
  }
  async function setAppMute(key, which, muted) {
    if (which !== 'local' && which !== 'tx') throw new Error('Destino inválido.');
    send(which === 'local' ? 'localmute' : 'txmute', key, muted ? '1' : '0');
    return { key, which, muted: !!muted };
  }
  async function getMaster() { return running ? (last.master ?? 100) : 100; }
  async function setMaster(percent) {
    if (!running) throw new Error('Roteamento de áudio desligado.');
    const pct = clamp(percent, 150);
    send('master', pct);
    return { master: pct };
  }
  function status() { return { running, platform: 'win32', source: 'helper', excluded: includeDiscord ? null : 'Discord', error: lastError }; }
  return { start, stop, status, listApps, setAppVolume, setAppMute, getMaster, setMaster };
}

module.exports = { createRouter, DISCORD_NAMES };
